/**
 * Lucy's launch proposals in the avatar panel (issue #3676).
 *
 * The server broadcasts every change over the dashboard socket (`lucy_launch`), to every
 * open tab. That broadcast is the only source for the card: this store never builds a card
 * from the answer to a button press or from a typed turn. Pressing Go / Cancel only asks the
 * server; the card closes when the server's `outcome` arrives.
 *
 * The browser never chooses or sends the permission level. The level on the card is the one
 * the server read when it made the proposal, shown as a label.
 */
import { useSyncExternalStore } from 'react';
import {
  LUCY_LAUNCH_CANCEL_PATH,
  LUCY_LAUNCH_CONFIRM_PATH,
  LUCY_LAUNCH_DECLINE_PATH,
  type LucyLaunchOutcome,
  type LucyLaunchProposalView,
  type LucyLaunchReport,
} from '../../shared/contracts/lucy-launch.js';
import { announceLaunchReport } from '../audio/ask-announcement.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';

export interface LucyLaunchResult {
  text: string;
  /** Set when a task was started: the line links to it. */
  taskId?: string;
}

export interface LucyLaunchSnapshot {
  proposal: LucyLaunchProposalView | null;
  conversationId: string | null;
  /** True while Go / Cancel is on its way to the server. */
  sending: boolean;
  /** Why the last press failed, if it did. */
  error: string | null;
  /** One line about the last proposal's end, shown after the card goes. */
  result: LucyLaunchResult | null;
  /** The last "task finished / needs you" sentence for a task she started. */
  report: LucyLaunchReport | null;
}

const EMPTY: LucyLaunchSnapshot = Object.freeze({
  proposal: null, conversationId: null, sending: false, error: null, result: null, report: null,
});

let snapshot: LucyLaunchSnapshot = EMPTY;
const listeners = new Set<() => void>();

function set(next: Partial<LucyLaunchSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

export function getLucyLaunchSnapshot(): LucyLaunchSnapshot {
  return snapshot;
}

export function useLucyLaunch(): LucyLaunchSnapshot {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getLucyLaunchSnapshot,
    getLucyLaunchSnapshot,
  );
}

export function describeOutcome(outcome: LucyLaunchOutcome): LucyLaunchResult {
  switch (outcome.outcome) {
    case 'launched': return { text: outcome.queued ? 'Started (queued)' : 'Started', taskId: outcome.taskId };
    case 'refused': return { text: outcome.reason };
    case 'declined':
    case 'cancelled': return { text: 'Cancelled' };
    case 'expired': return { text: 'That launch timed out' };
    case 'unknown': return { text: 'That request is no longer waiting' };
  }
}

/** Apply an `outcome`. Only the shown proposal is affected; one for any other id is ignored. */
export function applyLucyLaunchOutcome(outcome: LucyLaunchOutcome): void {
  if (snapshot.proposal?.id !== outcome.proposalId) return;
  set({ proposal: null, sending: false, error: null, result: describeOutcome(outcome) });
}

/** Apply a `lucy_launch` socket message. */
export function handleLucyLaunch(msg: Extract<ServerMessage, { type: 'lucy_launch' }>): void {
  if (msg.proposal) {
    set({ proposal: msg.proposal, conversationId: msg.conversationId, sending: false, error: null, result: null });
  } else if (msg.outcome) {
    applyLucyLaunchOutcome(msg.outcome);
  } else if (msg.report) {
    set({ report: msg.report });
    // Said aloud as well; the audio rules (sound, DND, one tab, waiting for Lucy) live in the announcer.
    void announceLaunchReport(msg.report.taskId, msg.report.kind);
  }
}

/** The card ran out of time by itself (`expiresAt` passed); the server's outcome may follow or may have been missed. */
export function expireLucyProposal(proposalId: string): void {
  if (snapshot.proposal?.id !== proposalId) return;
  set({ proposal: null, sending: false, error: null, result: { text: 'That launch timed out' } });
}

export function dismissLucyLaunchResult(): void {
  if (snapshot.result) set({ result: null });
}

export function dismissLucyReport(): void {
  if (snapshot.report) set({ report: null });
}

async function post(path: string, body: Record<string, unknown>, fetcher: typeof fetch): Promise<void> {
  const proposal = snapshot.proposal;
  if (!proposal || !snapshot.conversationId || snapshot.sending) return;
  set({ sending: true, error: null });
  try {
    const response = await fetcher(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: snapshot.conversationId, proposalId: proposal.id, ...body }),
    });
    if (!response.ok) {
      set({ sending: false, error: 'Lucy could not do that. Try again.' });
      return;
    }
    // The socket broadcast is what closes the card. The route's own answer is applied too, so a lost
    // broadcast does not leave a dead card; applying the same outcome twice is harmless.
    const data = (await response.json().catch(() => null)) as { outcome?: unknown; proposalId?: unknown } | null;
    if (data && typeof data.outcome === 'string' && typeof data.proposalId === 'string') {
      applyLucyLaunchOutcome(data as LucyLaunchOutcome);
    }
    if (snapshot.proposal?.id === proposal.id) set({ sending: false });
  } catch {
    set({ sending: false, error: 'Lucy could not be reached. Try again.' });
  }
}

/** Go (button or Enter). The body never carries a permission level; the server reads it. */
export function confirmLucyLaunch(via: 'enter' | 'click', fetcher: typeof fetch = fetch): Promise<void> {
  return post(LUCY_LAUNCH_CONFIRM_PATH, { via }, fetcher);
}

/** Cancel: declines a card that waits for the operator, cancels a hands-off one that is counting down. */
export function declineLucyLaunch(fetcher: typeof fetch = fetch): Promise<void> {
  const path = snapshot.proposal?.launchesAt !== undefined ? LUCY_LAUNCH_CANCEL_PATH : LUCY_LAUNCH_DECLINE_PATH;
  return post(path, {}, fetcher);
}

export function __resetLucyLaunchForTests(): void {
  snapshot = EMPTY;
  listeners.clear();
}
