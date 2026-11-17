/**
 * Lucy's action card: what she proposes to do to an existing task, in the avatar panel.
 *
 * Three kinds, one card at a time: answer a question the task asked, send it a reply, close it.
 * The card shows exactly what will happen and nothing is summarised: the task's name, the question
 * and the chosen choice, or the whole text that will be typed into the task. "Send" (or "Close")
 * carries it out; "Cancel" drops it. The operator's whole sentence "go" does the same as the button,
 * on the server. Unlike the launch card, Enter does not confirm it and there is never a countdown:
 * these wait for the operator at every permission level.
 *
 * The card goes by itself at `expiresAt`, and then turns into one result line ("Sent", "Closed", or
 * the reason nothing was done) that links to the task.
 *
 * It reuses the launch card's styles, and sits next to it above the composer: the server keeps one
 * proposal pending for both, so the two cards are never shown together.
 */
import { useEffect, useState } from 'react';
import { confirmLucyAction, declineLucyAction, expireLucyAction, useLucyAction } from '../store/lucy-action.js';
import type { LucyActionProposalView } from '../../shared/contracts/lucy-action.js';

const KIND_LABEL: Record<LucyActionProposalView['kind'], string> = { answer: 'Answer', reply: 'Reply', close: 'Close' };
const REGION_LABEL: Record<LucyActionProposalView['kind'], string> = {
  answer: 'Answer Lucy proposes to send',
  reply: 'Reply Lucy proposes to send',
  close: 'Task Lucy proposes to close',
};

/** "1 min 40 s", "40 s": how long the card can still be confirmed. */
export function timeLeftWords(untilMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

function ProposalBody({ proposal }: { proposal: LucyActionProposalView }) {
  switch (proposal.kind) {
    case 'answer':
      return (
        <>
          <p className="avatar-launch-asked" data-testid="avatar-action-question">
            <span className="avatar-live-who">Question</span> {proposal.question}
          </p>
          <p className="avatar-launch-description" data-testid="avatar-action-text">
            <span className="avatar-live-who">{proposal.answer.kind === 'option' ? 'Your choice' : 'Your answer'}</span>{' '}
            {proposal.answer.kind === 'option' ? proposal.answer.label : proposal.answer.text}
          </p>
        </>
      );
    case 'reply':
      return (
        <>
          <p className="avatar-launch-asked"><span className="avatar-live-who">Typed into the task</span></p>
          <p className="avatar-launch-description" data-testid="avatar-action-text">{proposal.text}</p>
        </>
      );
    case 'close':
      return (
        <p className="avatar-launch-description" data-testid="avatar-action-text">
          This task says it is finished. Closing it marks it complete and ends its session.
        </p>
      );
  }
}

export function LucyActionCard({ nowFn = Date.now }: { nowFn?: () => number } = {}) {
  const { proposal, sending, error } = useLucyAction();
  const [now, setNow] = useState(nowFn);
  const proposalId = proposal?.id;
  const expiresAt = proposal?.expiresAt;

  // Gone by itself at `expiresAt`, and the time left is shown until then.
  useEffect(() => {
    if (proposalId === undefined || expiresAt === undefined) return undefined;
    setNow(nowFn());
    const expire = setTimeout(() => expireLucyAction(proposalId), Math.max(0, expiresAt - nowFn()));
    const tick = setInterval(() => setNow(nowFn()), 1000);
    return () => { clearTimeout(expire); clearInterval(tick); };
  }, [proposalId, expiresAt, nowFn]);

  // What became of a card is written into the conversation by the store; the card itself only waits.
  if (!proposal) return null;
  return (
    <div className="avatar-launch" data-testid="avatar-action">
      {proposal && (
        <section className="avatar-launch-card" aria-label={REGION_LABEL[proposal.kind]} data-testid="avatar-action-card">
          <div className="avatar-launch-head">
            <span className="avatar-mark-diamond" aria-hidden="true" />
            <span className="avatar-launch-project" data-testid="avatar-action-title">{proposal.title}</span>
            <span className="avatar-launch-kind" data-testid="avatar-action-kind">{KIND_LABEL[proposal.kind]}</span>
          </div>
          {/* Long text scrolls inside the card (a region the keyboard can reach); the buttons below never do. */}
          <div className="avatar-launch-body" role="region" aria-label="What will be sent" tabIndex={0}>
            <ProposalBody proposal={proposal} />
            {proposal.asked && (
              <p className="avatar-launch-asked" data-testid="avatar-action-asked">
                <span className="avatar-live-who">You asked</span> {proposal.asked}
              </p>
            )}
          </div>
          <p className="avatar-launch-countdown" role="timer" data-testid="avatar-action-expiry">
            Waits for you for {timeLeftWords(proposal.expiresAt, now)}. Nothing happens unless you confirm.
          </p>
          {error && <p className="avatar-launch-error" role="alert" data-testid="avatar-action-error">{error}</p>}
          <div className="avatar-launch-buttons">
            <button
              type="button"
              className="avatar-ask-send"
              onClick={() => void confirmLucyAction()}
              aria-disabled={sending ? 'true' : undefined}
              data-testid="avatar-action-confirm"
            >
              {proposal.kind === 'close' ? 'Close' : 'Send'}
            </button>
            <button
              type="button"
              className="avatar-ask-option avatar-launch-cancel"
              onClick={() => void declineLucyAction()}
              aria-disabled={sending ? 'true' : undefined}
              data-testid="avatar-action-cancel"
            >
              Cancel
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
