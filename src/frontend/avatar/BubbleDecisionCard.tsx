/**
 * The card the minimised bubble grows into when a decision waits for the operator: one question from a task
 * (`kookr ask`) or one permission prompt, with its answer buttons, so the operator can answer without opening
 * Lucy. Which item it shows, and when, is decided by `bubble-decision.ts`; this file draws it and takes the
 * presses.
 *
 * A question is the compact variant of `AskCard.tsx` (same request, same refusals and "already answered"
 * handling as the full card). A prompt shows the task, the tool and the whole command in a box that scrolls
 * after about six lines, then Approve once and Deny. Under the item: "Open Lucy" (opens her column with the
 * waiting strip unfolded) and "Later" (puts the card away; the badge stays), and when more wait, "+N more
 * waiting", which opens the column too.
 *
 * It must never answer by accident, because it appears on its own over whatever the operator is doing:
 *  - it never takes keyboard focus (the panel announces it instead);
 *  - its answer buttons ignore presses for {@link ARMING_MS} after the card appears or its content changes;
 *  - a prompt whose command was cut short (it ends in an ellipsis) cannot be approved here.
 * Text from a task is shown as text, never as markup.
 */
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { askClockOffsetMs, markAskSubmitting, useOperatorAsks, type AskAnswerChoice } from '../store/operator-asks.js';
import { AskCard } from './AskCard.js';
import { sendPermissionChoice, waitedText, type PermissionChoiceSender } from './LucyPermissionCard.js';
import { permissionButtonsLive, useLucyPermission } from '../store/lucy-permission.js';
import type { BubbleDecision } from './bubble-decision.js';

/** Answer and Approve presses are ignored for this long after the card appears or its content changes. */
export const ARMING_MS = 600;

/** Said by a prompt card whose command is not whole. */
export const TRUNCATED_COMMAND_TEXT = 'The command is too long to show whole. Open the task to read it before you decide.';

export interface BubbleDecisionCardProps {
  decision: BubbleDecision;
  /** Send an answer over the dashboard socket; false when it could not be sent. */
  onAnswerAsk?: (askId: string, choice: AskAnswerChoice) => boolean;
  onPermissionChoice?: PermissionChoiceSender;
  /** Open her column with the waiting strip unfolded. */
  onOpenLucy: () => void;
  /** "Later", or Escape inside the card. */
  onLater: () => void;
  /** An answer was pressed on the card (for the log). */
  onAnswered: () => void;
}

export function BubbleDecisionCard({ decision, onAnswerAsk, onPermissionChoice, onOpenLucy, onLater, onAnswered }: BubbleDecisionCardProps) {
  const { item, outcome, moreCount, nowMs, rememberChoice } = decision;
  const { submit } = useOperatorAsks();
  const { pressed } = useLucyPermission();

  // Armed again whenever what the card shows changes: another item, a closed question, a changed question or command.
  const signature = item === null
    ? ''
    : item.kind === 'ask'
      ? `${item.key}|${item.ask.state}|${item.ask.question}|${item.ask.options.join('\n')}`
      : `${item.key}|${outcome ? 'done' : ''}|${item.card.toolName}|${item.card.command}`;
  const armedRef = useRef(false);
  const signatureRef = useRef('');
  if (signatureRef.current !== signature) {
    signatureRef.current = signature;
    armedRef.current = false;
  }
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    armedRef.current = false;
    setArmed(false);
    const timer = setTimeout(() => {
      armedRef.current = true;
      setArmed(true);
    }, ARMING_MS);
    return () => clearTimeout(timer);
  }, [signature]);

  const [permissionFailed, setPermissionFailed] = useState(false);

  if (item === null) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onLater();
  };

  const footer = (
    <div className="lucy-bubble-card-actions">
      <button type="button" className="avatar-ask-send" onClick={onOpenLucy} data-testid="lucy-bubble-card-open">
        Open Lucy
      </button>
      <button type="button" className="avatar-ask-option lucy-bubble-card-later" onClick={onLater} data-testid="lucy-bubble-card-later">
        Later
      </button>
    </div>
  );
  const more = moreCount > 0 && (
    <button type="button" className="avatar-launch-link lucy-bubble-card-more" onClick={onOpenLucy} data-testid="lucy-bubble-card-more">
      +{moreCount} more waiting
    </button>
  );

  let body;
  if (item.kind === 'ask') {
    const ask = item.ask;
    const answer = (askId: string, choice: AskAnswerChoice): void => {
      if (!armedRef.current) return;
      onAnswered();
      markAskSubmitting(askId, onAnswerAsk ? onAnswerAsk(askId, choice) : false);
    };
    body = (
      <ul className="avatar-asks lucy-bubble-card-list" role="list" aria-label="A question waiting for your answer">
        <AskCard
          ask={ask}
          submit={submit[ask.id]}
          nowMs={nowMs + askClockOffsetMs()}
          onAnswer={answer}
          onDismiss={() => {}}
          compact={{ answersLocked: !armed, onOpenLucy }}
        />
      </ul>
    );
  } else {
    const card = item.card;
    const live = permissionButtonsLive(card, nowMs);
    const isPressed = pressed.has(card.promptId);
    const truncated = card.command.trimEnd().endsWith('…');
    const press = (choice: 'approve' | 'deny'): void => {
      if (!armedRef.current || !onPermissionChoice || isPressed) return;
      if (choice === 'approve' && truncated) return;
      const sent = sendPermissionChoice(card, choice, onPermissionChoice);
      if (sent === null) return;
      setPermissionFailed(!sent);
      if (sent) {
        rememberChoice(item.key, choice === 'approve' ? 'Approve once' : 'Deny');
        onAnswered();
      }
    };
    const titleId = `lucy-bubble-card-title-${card.promptId.slice(0, 16)}`;
    const locked = !armed || isPressed;
    let note = 'Also on the finding card.';
    if (outcome) note = '';
    else if (isPressed) note = 'Sent. The card goes once the task moves on.';
    else if (permissionFailed) note = 'Not sent: the connection is down. Try again.';
    else if (truncated) note = TRUNCATED_COMMAND_TEXT;
    else if (!live) note = 'These buttons have timed out. Answer it in the task\'s terminal.';
    body = (
      <div className="avatar-ask avatar-ask-pending avatar-permission lucy-bubble-card-prompt" data-testid="lucy-bubble-card-permission" data-prompt-id={card.promptId}>
        <div className="avatar-ask-head">
          <span className="avatar-mark-diamond" aria-hidden="true" />
          <span className="avatar-ask-who" id={titleId} title={card.taskName ?? card.taskId}>{card.taskName ?? 'A task'} asks permission</span>
          <span className="avatar-ask-time">{waitedText(card.since, nowMs)}</span>
        </div>
        {outcome ? (
          <p className="avatar-ask-question" data-testid="lucy-bubble-card-outcome">{outcome.text}</p>
        ) : (
          <>
            <p className="avatar-ask-question">
              Waiting for your permission to use <span className="avatar-permission-tool">{card.toolName}</span>
            </p>
            {card.command && <pre className="avatar-permission-command lucy-bubble-command" tabIndex={0} data-testid="lucy-bubble-card-command">{card.command}</pre>}
            <div className="avatar-launch-buttons" role="group" aria-labelledby={titleId}>
              {card.approveKey && (
                <button
                  type="button"
                  className="avatar-ask-send"
                  onClick={() => press('approve')}
                  aria-disabled={locked || truncated ? 'true' : undefined}
                  data-testid="lucy-bubble-card-approve"
                >
                  Approve once
                </button>
              )}
              {card.denyKey && (
                <button
                  type="button"
                  className="avatar-ask-option avatar-launch-cancel"
                  onClick={() => press('deny')}
                  aria-disabled={locked ? 'true' : undefined}
                  data-testid="lucy-bubble-card-deny"
                >
                  Deny
                </button>
              )}
            </div>
          </>
        )}
        <p className="avatar-ask-note" data-testid="lucy-bubble-card-note">{note}</p>
      </div>
    );
  }

  return (
    <div
      className="lucy-bubble-card"
      role="group"
      aria-label={item.kind === 'ask' ? 'A decision is waiting for you' : 'A permission prompt is waiting for you'}
      onKeyDown={onKeyDown}
      data-testid="lucy-bubble-card"
      data-armed={armed ? 'true' : 'false'}
    >
      {body}
      {more}
      {footer}
    </div>
  );
}

