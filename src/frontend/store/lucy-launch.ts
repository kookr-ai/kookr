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
 *
 * The card is shown at the tail of the conversation thread. What became of a proposal (started,
 * cancelled, timed out) and the report of a task she started are written into the thread
 * (`store/lucy-conversation.ts`) as entries that stay, so nothing here needs dismissing. Every open
 * tab receives the same broadcast and the tabs share one saved thread, so those entries get an id
 * made from the proposal or the task: two tabs write one entry.
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
import { appendConversationEntry, getConversationEntries, removeConversationEntries } from './lucy-conversation.js';

export interface LucyLaunchResult {
  text: string;
  /** True when a task was launched. */
  started: boolean;
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
}

const EMPTY: LucyLaunchSnapshot = Object.freeze({
  proposal: null, conversationId: null, sending: false, error: null,
});

/** Two reports about the same task within this long are one report (every open tab receives each one). */
const SAME_REPORT_MS = 60_000;
/** How far back from the end of the thread a sentence is looked for. */
const RECENT_ENTRIES = 4;

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

/** Text compared without regard to line breaks and runs of spaces. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** True when two sentences are the same but for line breaks and runs of spaces. */
export function sameSentence(a: string, b: string): boolean {
  return flat(a) === flat(b);
}

/**
 * True when `text` is the read-back of the proposal on screen: the sentence she says about the card, which
 * repeats the card. With `partial`, also while `text` is only the beginning of it (it is still arriving).
 */
export function isLaunchReadBack(text: string, options: { partial?: boolean } = {}): boolean {
  const readBack = snapshot.proposal ? flat(snapshot.proposal.readBack) : '';
  const said = flat(text);
  if (!readBack || !said) return false;
  return options.partial ? readBack.startsWith(said) : readBack === said;
}

/** True when the proposal with this id is the card on screen. */
export function isLucyProposalShown(proposalId: string): boolean {
  return snapshot.proposal?.id === proposalId;
}

export function describeOutcome(outcome: LucyLaunchOutcome): LucyLaunchResult {
  switch (outcome.outcome) {
    case 'launched': return { text: `Started ${outcome.project} task${outcome.queued ? ' (queued)' : ''}`, started: true, taskId: outcome.taskId };
    case 'refused': return { text: outcome.reason, started: false };
    case 'declined':
    case 'cancelled': return { text: 'Cancelled', started: false };
    case 'expired': return { text: 'Timed out', started: false };
    case 'unknown': return { text: 'That request is no longer waiting', started: false };
  }
}

/** Write what became of a proposal into the thread, once per proposal however many tabs or messages say so. */
function recordOutcome(proposalId: string, result: LucyLaunchResult): void {
  appendConversationEntry(
    { kind: 'launch-outcome', text: result.text, started: result.started, ...(result.taskId ? { taskId: result.taskId } : {}) },
    { id: `launch-${proposalId}` },
  );
}

/** Apply an `outcome`. Only the shown proposal is affected; one for any other id is ignored. */
export function applyLucyLaunchOutcome(outcome: LucyLaunchOutcome): void {
  if (snapshot.proposal?.id !== outcome.proposalId) return;
  set({ proposal: null, sending: false, error: null });
  recordOutcome(outcome.proposalId, describeOutcome(outcome));
}

/** The card repeats her read-back: a bubble with that same sentence, just above it, is taken out. */
function dropReadBackBubble(): void {
  const recent = getConversationEntries().slice(-RECENT_ENTRIES);
  const repeats = recent.filter((entry) => (
    ((entry.kind === 'typed-lucy' && entry.status === 'done') || entry.kind === 'talk-lucy') && isLaunchReadBack(entry.text)
  ));
  if (repeats.length > 0) removeConversationEntries(repeats.map((entry) => entry.id));
}

/** Write the report of a task she started into the thread as a message of hers, with the task to open. */
function recordReport(report: LucyLaunchReport, nowMs: number): void {
  const recent = getConversationEntries().slice(-20);
  // Another tab may have written it already (the tabs share the thread).
  if (recent.some((entry) => entry.kind === 'lucy' && entry.taskId === report.taskId && entry.text === report.text && nowMs - entry.at < SAME_REPORT_MS)) return;
  appendConversationEntry(
    { kind: 'lucy', text: report.text, taskId: report.taskId },
    { id: `report-${report.taskId}-${report.kind}-${Math.floor(nowMs / SAME_REPORT_MS)}` },
  );
}

/** Apply a `lucy_launch` socket message. */
export function handleLucyLaunch(msg: Extract<ServerMessage, { type: 'lucy_launch' }>): void {
  if (msg.proposal) {
    set({ proposal: msg.proposal, conversationId: msg.conversationId, sending: false, error: null });
    dropReadBackBubble();
  } else if (msg.outcome) {
    applyLucyLaunchOutcome(msg.outcome);
  } else if (msg.report) {
    recordReport(msg.report, Date.now());
    // Said aloud as well; the audio rules (sound, DND, one tab, waiting for Lucy) live in the announcer.
    void announceLaunchReport(msg.report.taskId, msg.report.kind);
  }
}

/** The card ran out of time by itself (`expiresAt` passed); the server's outcome may follow or may have been missed. */
export function expireLucyProposal(proposalId: string): void {
  if (snapshot.proposal?.id !== proposalId) return;
  set({ proposal: null, sending: false, error: null });
  recordOutcome(proposalId, describeOutcome({ outcome: 'expired', proposalId }));
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
