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

/** Apply an `outcome`. Only the shown proposal is affected; one for any other id is ignored. */
export function applyLucyActionOutcome(outcome: LucyActionOutcome): void {
  const shown = snapshot.proposal;
  if (shown?.id !== outcome.proposalId) return;
  set({ proposal: null, sending: false, error: null, result: { text: describeActionOutcome(outcome), taskId: shown.taskId } });
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
  }
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
  listeners.clear();
}
