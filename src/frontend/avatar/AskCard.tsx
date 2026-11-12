/**
 * One `kookr ask` question in Lucy's panel.
 *
 * While the question is waiting it shows who asks, the question, the optional
 * background and one button per choice (plus a text box when the task accepts
 * a typed answer). Once it is closed it turns into a one-line outcome that says
 * where the answer came from ("Answered on Telegram: …", "You answered: …"),
 * because the same question is also on the operator's phone and they need to
 * see that the two agree.
 *
 * Purely presentational: the list, the sending state and the socket live in
 * `store/operator-asks.ts` and `AvatarDock.tsx`. So do two things a card cannot
 * do for itself, because it is replaced or removed when its question closes:
 * telling a screen reader the outcome, and keeping keyboard focus in the panel.
 */
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { AskSubmitState } from '../store/operator-asks.js';

/** Longest typed answer the server accepts. */
const MAX_ANSWER_CHARS = 1000;

export type AskAnswerChoice = { optionIndex: number } | { text: string };

export interface AskCardProps {
  ask: OperatorAskView;
  submit?: AskSubmitState;
  nowMs: number;
  onAnswer: (askId: string, choice: AskAnswerChoice) => void;
  onDismiss: (askId: string) => void;
}

/** "29 min left", "under a minute left". */
export function timeLeftText(expiresAt: number, nowMs: number): string {
  const minutes = Math.floor((expiresAt - nowMs) / 60_000);
  if (minutes < 1) return 'under a minute left';
  if (minutes < 120) return `${minutes} min left`;
  return `${Math.round(minutes / 60)} h left`;
}

function chosenText(ask: OperatorAskView): string {
  if (!ask.answer) return '';
  return ask.answer.kind === 'option' ? ask.answer.label : ask.answer.text;
}

/** A question shortened for a button's accessible name; the full text is in the card. */
function shortQuestion(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59).trimEnd()}…` : flat;
}

/** What a closed card says, and whether it is a good ending (answered) or not. */
export function askOutcome(ask: OperatorAskView): { text: string; answered: boolean } {
  if (ask.state === 'answered') {
    const chosen = chosenText(ask);
    return {
      // Records from before channels were tracked could only have come from Telegram.
      text: ask.answeredVia === 'dashboard' ? `You answered: ${chosen}` : `Answered on Telegram: ${chosen}`,
      answered: true,
    };
  }
  if (ask.state === 'expired') return { text: 'Expired with no answer', answered: false };
  if (ask.resolution === 'task_gone') return { text: 'The task ended before an answer was given', answered: false };
  return { text: 'The task withdrew this question', answered: false };
}

export function AskCard({ ask, submit, nowMs, onAnswer, onDismiss }: AskCardProps) {
  const [text, setText] = useState('');
  const questionId = useId();
  const who = ask.taskName ? `${ask.taskName} asks` : 'A task asks';

  if (ask.state !== 'pending') {
    const outcome = askOutcome(ask);
    return (
      <li className={`avatar-ask avatar-ask-closed${outcome.answered ? ' avatar-ask-answered' : ''}`} data-testid="avatar-ask" data-ask-id={ask.id} data-ask-state={ask.state}>
        <div className="avatar-ask-head">
          <span className={outcome.answered ? 'avatar-ask-check' : 'avatar-ask-dash'} aria-hidden="true" />
          {/* Not a live region: this card is mounted with its text already in it, which screen readers
              announce unreliably. The outcome is announced from the panel's always-present status region. */}
          <span className="avatar-ask-outcome" data-testid="avatar-ask-outcome">{outcome.text}</span>
          <button
            type="button"
            className="avatar-dock-button avatar-ask-dismiss"
            onClick={() => onDismiss(ask.id)}
            aria-label={`Dismiss the question "${shortQuestion(ask.question)}"`}
            title="Dismiss"
            data-testid="avatar-ask-dismiss"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
        <p className="avatar-ask-question avatar-ask-question-closed">{ask.question}</p>
      </li>
    );
  }

  const sending = submit?.status === 'sending';
  const refusal = submit?.status === 'refused' ? submit.message : null;
  const trimmed = text.trim();
  const answer = (choice: AskAnswerChoice): void => {
    if (sending) return;
    onAnswer(ask.id, choice);
  };
  const onSubmitText = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!trimmed) return;
    answer({ text: trimmed });
  };

  return (
    <li className="avatar-ask avatar-ask-pending" data-testid="avatar-ask" data-ask-id={ask.id} data-ask-state="pending">
      <div className="avatar-ask-head">
        <span className="avatar-mark-diamond" aria-hidden="true" />
        <span className="avatar-ask-who" title={who}>{who}</span>
        <span className="avatar-ask-time">{timeLeftText(ask.expiresAt, nowMs)}</span>
      </div>
      <p className="avatar-ask-question" id={questionId} data-testid="avatar-ask-question">{ask.question}</p>
      {ask.context && (
        <details className="avatar-ask-context">
          <summary>Background</summary>
          <p>{ask.context}</p>
        </details>
      )}
      {/* One group named by the question, so with several cards open each choice, text box and Send
          button is announced with the question it belongs to. */}
      <div className="avatar-ask-answers" role="group" aria-labelledby={questionId}>
      <div className="avatar-ask-options">
        {ask.options.map((label, index) => (
          <button
            key={`${index}-${label}`}
            type="button"
            className="avatar-ask-option"
            onClick={() => answer({ optionIndex: index })}
            // aria-disabled, like the panel's other buttons: focus stays put while the answer is on its way.
            aria-disabled={sending ? 'true' : undefined}
            data-testid="avatar-ask-option"
          >
            {label}
          </button>
        ))}
      </div>
      {ask.allowText && (
        <form className="avatar-ask-text" onSubmit={onSubmitText}>
          <input
            type="text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={MAX_ANSWER_CHARS}
            placeholder="Or type another answer"
            aria-label="Type another answer"
            readOnly={sending}
            data-testid="avatar-ask-input"
          />
          <button type="submit" className="avatar-ask-send" aria-disabled={sending || !trimmed ? 'true' : undefined} data-testid="avatar-ask-send">
            Send
          </button>
        </form>
      )}
      </div>
      {/* Always present, only emptied, so a refusal is announced when it appears. */}
      <p className="avatar-ask-note" role="status" data-testid="avatar-ask-note">
        {sending ? 'Sending your answer…' : refusal ?? 'Also on Telegram. The first answer wins.'}
      </p>
    </li>
  );
}
