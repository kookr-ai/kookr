/**
 * The `kookr ask` questions Lucy shows in the avatar panel.
 *
 * A running task can ask the operator a multiple-choice question
 * (`kookr ask`). It reaches the operator's phone over Telegram, and the server
 * also pushes it here (`operatorAsks` on the dashboard socket) so Lucy can ask
 * it out loud and take the answer in her panel. Both channels share one record
 * on the server: the list pushed here is always the whole current truth
 * (pending questions plus those closed in the last few minutes), so an answer
 * given on Telegram shows up here as "answered on Telegram" without any
 * bookkeeping in the browser.
 *
 * What lives only in the browser:
 *  - which answer this tab is sending right now, and why the last one was refused;
 *  - which closed questions the operator dismissed from the panel;
 *  - the "a question just arrived" event (`announce`) that makes Lucy speak. It is
 *    an event, not state: a reload must not make her ask again.
 */
import { useSyncExternalStore } from 'react';
import {
  OPERATOR_ASK_RESOLVED_VISIBLE_MS,
  type AnswerRejection,
  type OperatorAskView,
} from '../../shared/contracts/asks.js';
import type { ClientMessage } from '../../shared/contracts/messages.js';

/** What the operator chose on a card: one of the buttons, or typed text. */
export type AskAnswerChoice = { optionIndex: number } | { text: string };

/** The socket message that carries an answer given in Lucy's panel. */
export function buildAnswerAskMessage(askId: string, choice: AskAnswerChoice): Extract<ClientMessage, { type: 'answerAsk' }> {
  return { type: 'answerAsk', askId, ...choice };
}

export type AskSubmitState =
  | { status: 'sending' }
  | { status: 'refused'; message: string };

export interface OperatorAsksSnapshot {
  /** Newest first, as the server sent them, minus the ones dismissed here. */
  asks: readonly OperatorAskView[];
  /** Per ask id: an answer on its way, or the reason the last one was refused. */
  submit: Readonly<Record<string, AskSubmitState>>;
}

/**
 * How long an answer may stay "sending" with no reply. The reply normally takes a moment; none at all
 * means the message was lost (the connection dropped right after it left, or the server restarted),
 * and without this the card would refuse every further press until a reload. Trying again is safe: if
 * the first answer did get through, the server says "already answered" and the card shows it.
 */
export const ASK_REPLY_TIMEOUT_MS = 10_000;

const EMPTY: OperatorAsksSnapshot = Object.freeze({ asks: Object.freeze([]) as readonly OperatorAskView[], submit: Object.freeze({}) });

let serverAsks: readonly OperatorAskView[] = [];
let dismissed = new Set<string>();
let submit: Record<string, AskSubmitState> = {};
const replyTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearReplyTimer(askId: string): void {
  const timer = replyTimers.get(askId);
  if (timer !== undefined) clearTimeout(timer);
  replyTimers.delete(askId);
}
let snapshot: OperatorAsksSnapshot = EMPTY;
const listeners = new Set<() => void>();
const announceListeners = new Set<(ask: OperatorAskView) => void>();
const closedListeners = new Set<(ask: OperatorAskView) => void>();

/** Words for a refusal the server reported; the fresh list that follows shows the real state of the card. */
const REFUSAL_TEXT: Record<AnswerRejection | 'unavailable' | 'offline' | 'no_reply' | 'failed', string> = {
  not_found: 'This question no longer exists.',
  forged: 'The answer was refused.',
  already_answered: 'This question was already answered.',
  expired: 'This question expired before your answer arrived.',
  cancelled: 'The task withdrew this question.',
  wrong_chat: 'The answer was refused.',
  bad_option: 'That answer is empty or too long (1000 characters at most).',
  text_not_allowed: 'This question only accepts the buttons.',
  task_gone: 'The task is no longer running, so the answer was not delivered.',
  unavailable: 'Questions are not available on this server.',
  offline: 'Not connected to Kookr. Try again in a moment.',
  no_reply: 'Kookr did not confirm your answer. Try again.',
  failed: 'Kookr could not record your answer. Try again.',
};

function publish(): void {
  const asks = serverAsks.filter((ask) => !dismissed.has(ask.id));
  snapshot = asks.length === 0 && Object.keys(submit).length === 0 ? EMPTY : { asks, submit: { ...submit } };
  for (const listener of listeners) listener();
}

/**
 * Apply an `operatorAsks` message. `announce` names the question that was just
 * created; listeners registered with {@link onAskAnnounced} hear it once.
 */
export function handleOperatorAsks(asks: readonly OperatorAskView[], announce?: string): void {
  const before = new Map(serverAsks.map((ask) => [ask.id, ask]));
  serverAsks = asks;
  const ids = new Set(asks.map((ask) => ask.id));
  dismissed = new Set([...dismissed].filter((id) => ids.has(id)));
  for (const id of Object.keys(submit)) {
    const ask = asks.find((a) => a.id === id);
    // The card now shows what happened (answered, expired...), which says more than a stale notice.
    if (!ask || ask.state !== 'pending') {
      delete submit[id];
      clearReplyTimer(id);
    }
  }
  publish();
  for (const ask of asks) {
    const previous = before.get(ask.id);
    if (ask.state !== 'pending' && previous?.state === 'pending') {
      for (const listener of closedListeners) listener(ask);
    }
  }
  if (announce) {
    const created = asks.find((ask) => ask.id === announce && ask.state === 'pending');
    if (created) for (const listener of announceListeners) listener(created);
  }
}

/** Apply an `operatorAskResult` message: the reply to an answer this tab sent. */
export function handleOperatorAskResult(askId: string, ok: boolean, reason?: string): void {
  clearReplyTimer(askId);
  if (ok) delete submit[askId];
  else submit[askId] = { status: 'refused', message: REFUSAL_TEXT[(reason ?? 'unavailable') as keyof typeof REFUSAL_TEXT] ?? 'The answer was refused.' };
  publish();
}

/** Note that an answer is on its way, or could not even be sent (`sent` false: the socket is down). */
export function markAskSubmitting(askId: string, sent: boolean): void {
  clearReplyTimer(askId);
  submit[askId] = sent ? { status: 'sending' } : { status: 'refused', message: REFUSAL_TEXT.offline };
  if (sent) {
    replyTimers.set(askId, setTimeout(() => {
      replyTimers.delete(askId);
      if (submit[askId]?.status !== 'sending') return;
      submit[askId] = { status: 'refused', message: REFUSAL_TEXT.no_reply };
      publish();
    }, ASK_REPLY_TIMEOUT_MS));
  }
  publish();
}

/** Hide a closed question from the panel. Pending questions cannot be dismissed. */
export function dismissOperatorAsk(askId: string): void {
  const ask = serverAsks.find((a) => a.id === askId);
  if (!ask || ask.state === 'pending') return;
  dismissed.add(askId);
  publish();
}

/** A question was just created (not merely listed after a reload). Returns an unsubscribe function. */
export function onAskAnnounced(listener: (ask: OperatorAskView) => void): () => void {
  announceListeners.add(listener);
  return () => { announceListeners.delete(listener); };
}

/** A question this tab knew as pending is no longer pending (answered on either channel, expired, cancelled). */
export function onAskClosed(listener: (ask: OperatorAskView) => void): () => void {
  closedListeners.add(listener);
  return () => { closedListeners.delete(listener); };
}

/** When a closed question closed. The server always sends it; the fallback covers an older server. */
function askClosedAt(ask: OperatorAskView): number {
  return ask.resolvedAt ?? ask.expiresAt;
}

/**
 * The questions to show at `nowMs`: every pending one, and closed ones for
 * {@link OPERATOR_ASK_RESOLVED_VISIBLE_MS} after they closed. The server stops
 * listing a closed question only on its next push, so the panel applies the
 * same window itself.
 */
export function visibleOperatorAsks(asks: readonly OperatorAskView[], nowMs: number): OperatorAskView[] {
  return asks.filter((ask) => ask.state === 'pending' || nowMs - askClosedAt(ask) <= OPERATOR_ASK_RESOLVED_VISIBLE_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getOperatorAsksSnapshot(): OperatorAsksSnapshot {
  return snapshot;
}

export function useOperatorAsks(): OperatorAsksSnapshot {
  return useSyncExternalStore(subscribe, getOperatorAsksSnapshot, () => EMPTY);
}

export function __resetOperatorAsksForTests(): void {
  serverAsks = [];
  dismissed = new Set();
  submit = {};
  for (const timer of replyTimers.values()) clearTimeout(timer);
  replyTimers.clear();
  snapshot = EMPTY;
  listeners.clear();
  announceListeners.clear();
  closedListeners.clear();
}
