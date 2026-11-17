/**
 * Lucy's launch card (issue #3676): what she proposes to start, in the avatar panel.
 *
 * The card shows the project, whether it is an investigation or an implementation, the whole task
 * description (never a summary), the operator's own words it was built from, and the level in force as a
 * small label. "Go" (or Enter) confirms; "Cancel" declines. A hands-off card has no "Go": it counts down
 * to `launchesAt`, when the server starts the task by itself, and only "Cancel" is offered.
 *
 * Enter confirms only when focus is not in a text field, a button or a link (Enter there already means
 * something else). The card also goes by itself at `expiresAt`.
 *
 * The card is part of the conversation: the dock puts it at the tail of the thread (`LucyThread`'s
 * `pendingCards`), which scrolls it into view. A long description makes the card taller and the thread scrolls;
 * the card has no scroll box of its own. When the proposal ends the card goes and the store writes what became
 * of it into the thread as an entry that stays ("Started kookr task", "Cancelled", "Timed out"), as it does for
 * the report of a task she started (`store/lucy-launch.ts`).
 *
 * The line "You asked" is left out when the operator's sentence is the entry right above the card.
 *
 * Purely the browser half of a server rule: no level is decided or sent from here.
 */
import { useEffect, useState } from 'react';
import {
  confirmLucyLaunch,
  declineLucyLaunch,
  expireLucyProposal,
  sameSentence,
  useLucyLaunch,
} from '../store/lucy-launch.js';
import { useLucyConversation } from '../store/lucy-conversation.js';
import { useKookrStore } from '../store/useStore.js';
import type { LucyLaunchProposalView } from '../../shared/contracts/lucy-launch.js';

const LEVEL_LABEL: Record<LucyLaunchProposalView['level'], string> = {
  careful: 'Careful',
  balanced: 'Balanced',
  'hands-off': 'Hands-off',
};
const KIND_LABEL: Record<LucyLaunchProposalView['kind'], string> = {
  investigation: 'Investigation',
  implementation: 'Implementation',
};

/** Select a task in the dashboard, the same way opening an existing duplicate in Quick Launch does. */
export function openLucyTask(taskId: string): void {
  const state = useKookrStore.getState();
  const agent = state.agents.find((a) => a.taskId === taskId);
  if (agent) state.selectAgent(agent.agentId, taskId);
}

/** True when Enter pressed with focus on `target` already has another meaning. */
export function enterBelongsToTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest('input, textarea, select, button, a, [role="button"], [contenteditable="true"]') !== null;
}

function secondsLeft(untilMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}

export function LucyLaunchCard({ nowFn = Date.now }: { nowFn?: () => number } = {}) {
  const { proposal, sending, error } = useLucyLaunch();
  const entries = useLucyConversation();
  const [now, setNow] = useState(nowFn);
  const proposalId = proposal?.id;
  const expiresAt = proposal?.expiresAt;
  const handsOff = proposal?.launchesAt !== undefined;

  // Gone by itself at `expiresAt`.
  useEffect(() => {
    if (proposalId === undefined || expiresAt === undefined) return undefined;
    const timer = setTimeout(() => expireLucyProposal(proposalId), Math.max(0, expiresAt - nowFn()));
    return () => clearTimeout(timer);
  }, [proposalId, expiresAt, nowFn]);

  // The countdown of a hands-off card.
  useEffect(() => {
    if (!handsOff) return undefined;
    setNow(nowFn());
    const timer = setInterval(() => setNow(nowFn()), 250);
    return () => clearInterval(timer);
  }, [handsOff, proposalId, nowFn]);

  // Enter confirms a card that waits for the operator.
  useEffect(() => {
    if (proposalId === undefined || handsOff) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return;
      // The card is sent to every open tab: an Enter in a tab nobody is looking at must not launch it.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (enterBelongsToTarget(event.target)) return;
      // An open dialog owns Enter (it confirms itself on Enter): the card must not launch beneath it.
      if (typeof document !== 'undefined' && document.querySelector('[aria-modal="true"], [role="dialog"], [role="alertdialog"], .dialog-overlay') !== null) return;
      event.preventDefault();
      // The dashboard also uses a bare Enter to advance to the next task. While a card waits, Enter is the card's:
      // listening in the capture phase makes that independent of the order other listeners were added in.
      event.stopPropagation();
      void confirmLucyLaunch('enter');
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [proposalId, handsOff]);

  if (!proposal) return null;
  // The entry right above the card; her reply still being prepared shows no bubble, so it does not count.
  const above = [...entries].reverse().find((entry) => !(entry.kind === 'typed-lucy' && entry.status === 'pending'));
  const askedIsAbove = above !== undefined && (above.kind === 'typed-you' || above.kind === 'talk-you') && sameSentence(above.text, proposal.asked);
  return (
    // Keyed by the proposal, so a new proposal is a new card: the thread then brings it into view.
    <div className="avatar-launch" data-testid="avatar-launch" key={proposal.id}>
      <section className="avatar-launch-card" aria-label="Task Lucy proposes to start" data-testid="avatar-launch-card">
        <div className="avatar-launch-head">
          <span className="avatar-mark-diamond" aria-hidden="true" />
          <span className="avatar-launch-project" data-testid="avatar-launch-project">{proposal.project}</span>
          <span className="avatar-launch-kind" data-testid="avatar-launch-kind">{KIND_LABEL[proposal.kind]}</span>
          <span className="avatar-launch-level" data-testid="avatar-launch-level">{LEVEL_LABEL[proposal.level]}</span>
        </div>
        <div className="avatar-launch-body">
          <p className="avatar-launch-description" data-testid="avatar-launch-description">{proposal.description}</p>
          {!askedIsAbove && (
            <p className="avatar-launch-asked" data-testid="avatar-launch-asked">
              <span className="avatar-live-who">You asked</span> {proposal.asked}
            </p>
          )}
        </div>
        {handsOff && proposal.launchesAt !== undefined && (
          <p className="avatar-launch-countdown" role="timer" data-testid="avatar-launch-countdown">
            Starts in {secondsLeft(proposal.launchesAt, now)} s unless you cancel.
          </p>
        )}
        {error && <p className="avatar-launch-error" role="alert" data-testid="avatar-launch-error">{error}</p>}
        <div className="avatar-launch-buttons">
          {!handsOff && (
            <button
              type="button"
              className="avatar-ask-send"
              onClick={() => void confirmLucyLaunch('click')}
              aria-disabled={sending ? 'true' : undefined}
              aria-busy={sending ? 'true' : undefined}
              data-testid="avatar-launch-go"
            >
              {/* A launch takes 10 to 20 seconds: say that it is under way, a dimmed "Go" reads as a dead button. */}
              {sending ? 'Starting…' : 'Go'}
            </button>
          )}
          <button
            type="button"
            className="avatar-ask-option avatar-launch-cancel"
            onClick={() => void declineLucyLaunch()}
            aria-disabled={sending ? 'true' : undefined}
            data-testid="avatar-launch-cancel"
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
