/**
 * Lucy's proposals about an existing task in the avatar panel: answer a question it asked, send
 * it a reply, close it.
 *
 * Like her launch card (`lucy-launch.ts`), the card comes only from the server's broadcast over the
 * dashboard socket (`lucy_action`), sent to every open tab. This store never builds a card from the
 * answer to a button press or from a typed turn. Pressing Send / Close / Cancel only asks the server;
 * the card closes when the server's `outcome` arrives.
 *
 * The browser sends the conversation and the proposal id, and nothing else: what is sent or closed
 * is what the server held when it made the card.
 */
import { useSyncExternalStore } from 'react';
import {
  describeActionOutcome,
  LUCY_ACTION_CONFIRM_PATH,
  LUCY_ACTION_DECLINE_PATH,
  type LucyActionOutcome,
  type LucyActionProposalView,
} from '../../shared/contracts/lucy-action.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { appendConversationEntry, updateConversationEntry } from './lucy-conversation.js';

export interface LucyActionResult {
  text: string;
  /** The task the proposal was about: the line links to it. */
  taskId?: string;
}

export interface LucyActionSnapshot {
  proposal: LucyActionProposalView | null;
  conversationId: string | null;
  /** True while Send / Close / Cancel is on its way to the server. */
  sending: boolean;
  /** Why the last press failed, if it did. */
  error: string | null;
  /** One line about the last proposal's end, shown after the card goes. */
  result: LucyActionResult | null;
}

const EMPTY: LucyActionSnapshot = Object.freeze({ proposal: null, conversationId: null, sending: false, error: null, result: null });

let snapshot: LucyActionSnapshot = EMPTY;
const listeners = new Set<() => void>();
/** Proposals this tab ended as "timed out" by its own clock, with what the line needs if the server's real outcome follows. */
const expiredHere = new Map<string, { title: string; taskId?: string }>();
const MAX_REMEMBERED_EXPIRIES = 20;

function set(next: Partial<LucyActionSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

export function getLucyActionSnapshot(): LucyActionSnapshot {
  return snapshot;
}

export function useLucyAction(): LucyActionSnapshot {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getLucyActionSnapshot,
    getLucyActionSnapshot,
  );
}

/**
 * Apply an `outcome`. Only the shown proposal closes; one for any other id is ignored, except the real outcome of a
 * proposal this tab already ended as "timed out" (a reply or close that went through just as the card ran out),
 * which replaces that line so the thread does not keep saying it timed out.
 */
export function applyLucyActionOutcome(outcome: LucyActionOutcome): void {
  const shown = snapshot.proposal;
  if (shown?.id !== outcome.proposalId) {
    const expired = expiredHere.get(outcome.proposalId);
    if (expired && outcome.outcome !== 'expired' && outcome.outcome !== 'unknown') {
      expiredHere.delete(outcome.proposalId);
      updateConversationEntry(`action-${outcome.proposalId}`, {
        text: `${expired.title}: ${describeActionOutcome(outcome)}`,
        started: outcome.outcome === 'done',
        ...(expired.taskId ? { taskId: expired.taskId } : {}),
      });
    }
    return;
  }
  const text = describeActionOutcome(outcome);
  set({ proposal: null, sending: false, error: null, result: { text, taskId: shown.taskId } });
  // What became of the card is kept in the conversation, like a launch: once per proposal, however many tabs say so.
  appendConversationEntry(
    { kind: 'launch-outcome', text: `${shown.title}: ${text}`, started: outcome.outcome === 'done', ...(shown.taskId ? { taskId: shown.taskId } : {}) },
    { id: `action-${outcome.proposalId}` },
  );
}

/** The parts of a `lucy_action` socket message this store reads: a card to show, or what became of it. */
export type LucyActionMessage = Pick<Extract<ServerMessage, { type: 'lucy_action' }>, 'conversationId'> & {
  proposal?: LucyActionProposalView;
  outcome?: LucyActionOutcome;
};

/** Apply a `lucy_action` socket message. */
export function handleLucyAction(msg: LucyActionMessage): void {
  if (msg.proposal) {
    set({ proposal: msg.proposal, conversationId: msg.conversationId, sending: false, error: null, result: null });
  } else if (msg.outcome) {
    applyLucyActionOutcome(msg.outcome);
  }
}

/** The card ran out of time by itself (`expiresAt` passed); the server's outcome may follow or may have been missed. */
export function expireLucyAction(proposalId: string): void {
  const shown = snapshot.proposal;
  if (shown?.id !== proposalId) return;
  // A press is on its way: the route's answer or the broadcast closes the card with what really happened.
  if (snapshot.sending) return;
  if (expiredHere.size >= MAX_REMEMBERED_EXPIRIES) expiredHere.clear();
  expiredHere.set(proposalId, { title: shown.title, ...(shown.taskId ? { taskId: shown.taskId } : {}) });
  applyLucyActionOutcome({ outcome: 'expired', proposalId });
}

export function dismissLucyActionResult(): void {
  if (snapshot.result) set({ result: null });
}

async function post(path: string, fetcher: typeof fetch): Promise<void> {
  const proposal = snapshot.proposal;
  if (!proposal || !snapshot.conversationId || snapshot.sending) return;
  set({ sending: true, error: null });
  try {
    const response = await fetcher(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: snapshot.conversationId, proposalId: proposal.id }),
    });
    if (!response.ok) {
      set({ sending: false, error: 'Lucy could not do that. Try again.' });
      expireIfDue(proposal);
      return;
    }
    // The socket broadcast is what closes the card. The route's own answer is applied too, so a lost
    // broadcast does not leave a dead card; applying the same outcome twice is harmless.
    const data = (await response.json().catch(() => null)) as { outcome?: unknown; proposalId?: unknown } | null;
    if (data && typeof data.outcome === 'string' && typeof data.proposalId === 'string') {
      applyLucyActionOutcome(data as LucyActionOutcome);
    }
    if (snapshot.proposal?.id === proposal.id) set({ sending: false });
  } catch {
    set({ sending: false, error: 'Lucy could not be reached. Try again.' });
    expireIfDue(proposal);
  }
}

/** The card's own timer skipped its expiry while a press was in flight; if the press failed after that, end the card now. */
function expireIfDue(proposal: LucyActionProposalView): void {
  if (Date.now() >= proposal.expiresAt) expireLucyAction(proposal.id);
}

/** Send / Close: a click on the card. The body names the card and nothing else. */
export function confirmLucyAction(fetcher: typeof fetch = fetch): Promise<void> {
  return post(LUCY_ACTION_CONFIRM_PATH, fetcher);
}

export function declineLucyAction(fetcher: typeof fetch = fetch): Promise<void> {
  return post(LUCY_ACTION_DECLINE_PATH, fetcher);
}

export function __resetLucyActionForTests(): void {
  snapshot = EMPTY;
  expiredHere.clear();
  listeners.clear();
}
