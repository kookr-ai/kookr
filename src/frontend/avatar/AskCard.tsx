/**
 * One `kookr ask` question in Lucy's panel.
 *
 * While the question is waiting it shows who asks, the question, the optional
 * background, a button per page the question links to (`kookr ask --link`) and
 * an "Open task" button that selects the asking task, then one button per
 * choice (plus a text box when the task accepts a typed answer). URLs written
 * in the question or its background are clickable too. Once it is closed it
 * turns into a one-line outcome that says where the answer came from
 * ("Answered on Telegram: …", "You answered: …"), because the same question is also on the operator's phone and they need to
 * see that the two agree.
 *
 * In the tray (`WaitingTray.tsx`) only one pending card is open at a time; the others are one-line rows.
 * An open card's top line is then a button that folds it back (`onCollapse`), and the text typed into
 * its answer box is kept by the tray (`draft`), so folding a card does not lose a half-typed answer.
 *
 * Purely presentational: the list, the sending state and the socket live in
 * `store/operator-asks.ts`, `WaitingTray.tsx` and `AvatarDock.tsx`. So do two things a card cannot
 * do for itself, because it is replaced or removed when its question closes:
 * telling a screen reader the outcome, and keeping keyboard focus in the panel.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ASK_LIMITS, DEFAULT_ASK_LINK_LABEL, type OperatorAskView } from '../../shared/contracts/asks.js';
import type { AskAnswerChoice, AskSubmitState } from '../store/operator-asks.js';
import { isOpenableUrl, splitLinks } from './ask-links.js';

export type { AskAnswerChoice };

/** Longest typed answer the server accepts. */
const MAX_ANSWER_CHARS = ASK_LIMITS.maxAnswerTextChars;

export interface AskCardProps {
  ask: OperatorAskView;
  submit?: AskSubmitState;
  nowMs: number;
  onAnswer: (askId: string, choice: AskAnswerChoice) => void;
  onDismiss: (askId: string) => void;
  /**
   * Select the asking task in the dashboard. Returns false when it cannot be shown (it has no live
   * session in the dashboard), so the card can say so. Absent: no "Open task" button.
   */
  onOpenTask?: (taskId: string) => boolean;
  /** Present when the card sits in a list of folded rows: the card's top line then folds it back to a row. */
  onCollapse?: () => void;
  /** The text typed into the answer box, kept by the caller so it survives the card being folded away. */
  draft?: { value: string; set: (value: string) => void };
  /**
   * The compact variant the minimised bubble's card uses (`BubbleDecisionCard.tsx`): the question is cut to five
   * lines with "Show all"; there is no background, no links, no "Open task" and no text box; and when the
   * answers cannot be shown as a few short buttons they are replaced by one "Open Lucy to answer" button.
   * `answersLocked` makes the answer buttons ignore presses (the card has only just appeared or changed).
   */
  compact?: { answersLocked: boolean; onOpenLucy: () => void };
}

/** The compact card shows at most this many answer buttons, and none longer than this: past that it sends the operator to the full card. */
export const COMPACT_MAX_OPTIONS = 4;
export const COMPACT_MAX_OPTION_CHARS = 40;
/** A question that is probably longer than five lines of the compact card, for where the browser cannot measure. */
const COMPACT_LONG_QUESTION_CHARS = 200;

/** Whether the answers fit the compact card as buttons. */
export function optionsFitCompactCard(options: readonly string[]): boolean {
  return options.length > 0 && options.length <= COMPACT_MAX_OPTIONS && options.every((label) => label.length <= COMPACT_MAX_OPTION_CHARS);
}

/** Shown when "Open task" could not select the task. */
export const OPEN_TASK_FAILED_TEXT = 'This task is not shown in the dashboard right now.';

/** `text` with every http(s) URL in it rendered as a link that opens in a new tab. */
export function TextWithLinks({ text }: { text: string }): ReactNode {
  return splitLinks(text).map((segment, i) => (segment.kind === 'url'
    ? <a key={i} href={segment.url} target="_blank" rel="noopener noreferrer" className="avatar-ask-inline-link">{segment.url}</a>
    : segment.text));
}

/** "29 min left", "under a minute left". */
export function timeLeftText(expiresAt: number, nowMs: number): string {
  const minutes = Math.floor((expiresAt - nowMs) / 60_000);
  if (minutes < 1) return 'under a minute left';
  if (minutes < 120) return `${minutes} min left`;
  return `${Math.round(minutes / 60)} h left`;
}

/** "29 min", "under a minute", "4 h": how long until a question closes, without the word "left". */
export function closesInText(expiresAt: number, nowMs: number): string {
  const minutes = Math.floor((expiresAt - nowMs) / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

function chosenText(ask: OperatorAskView): string {
  if (!ask.answer) return '';
  return ask.answer.kind === 'option' ? ask.answer.label : ask.answer.text;
}

/** Shown on the closed card when the answer was recorded but Kookr could not type it into the task's session. */
export const UNDELIVERED_TEXT = 'Kookr could not type your answer into the task. It is recorded, and the task can still read it.';
/** Shown when the answer came after the session that asked had ended: it is kept, and nothing was typed. */
export const NOT_TYPED_TEXT = 'Recorded. The session that asked has ended, so nothing was typed into it.';

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
  if (ask.resolution === 'task_gone') return { text: 'The session that asked ended before an answer was given', answered: false };
  return { text: 'The task withdrew this question', answered: false };
}

export function AskCard({ ask, submit, nowMs, onAnswer, onDismiss, onOpenTask, onCollapse, draft, compact }: AskCardProps) {
  const [ownText, setOwnText] = useState('');
  const text = draft ? draft.value : ownText;
  const setText = draft ? draft.set : setOwnText;
  const [openTaskFailed, setOpenTaskFailed] = useState(false);
  const questionId = useId();
  // Compact variant: the question is cut to five lines; "Show all" shows the rest.
  const [showAll, setShowAll] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const questionRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (!compact || showAll) return;
    const element = questionRef.current;
    // Where nothing can be measured (a test browser), a long question is assumed to be cut.
    setOverflowing(element && element.clientHeight > 0
      ? element.scrollHeight > element.clientHeight + 1
      : ask.question.length > COMPACT_LONG_QUESTION_CHARS || ask.question.split('\n').length > 5);
  }, [compact, showAll, ask.question]);
  const who = ask.system ? 'Kookr asks' : ask.taskName ? `${ask.taskName} asks` : 'A task asks';
  // The server only accepts https links; this guards against an old or hand-edited record all the same.
  const links = (ask.links ?? []).filter((link) => isOpenableUrl(link.url));

  if (ask.state !== 'pending') {
    const outcome = askOutcome(ask);
    return (
      // Focusable from script only: the panel moves focus here when the control that had it went away with the pending card.
      <li className={`avatar-ask avatar-ask-closed${outcome.answered ? ' avatar-ask-answered' : ''}`} tabIndex={-1} data-testid="avatar-ask" data-ask-id={ask.id} data-ask-state={ask.state}>
        <div className="avatar-ask-head">
          <span className={outcome.answered ? 'avatar-ask-check' : 'avatar-ask-dash'} aria-hidden="true" />
          {/* Not a live region: this card is mounted with its text already in it, which screen readers
              announce unreliably. The outcome is announced from the panel's always-present status region. */}
          <span className="avatar-ask-outcome" data-testid="avatar-ask-outcome">{outcome.text}</span>
          {!compact && <button
            type="button"
            className="avatar-dock-button avatar-ask-dismiss"
            onClick={() => onDismiss(ask.id)}
            aria-label={`Dismiss the question "${shortQuestion(ask.question)}"`}
            title="Dismiss"
            data-testid="avatar-ask-dismiss"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>}
        </div>
        <p className="avatar-ask-question avatar-ask-question-closed">{ask.question}</p>
        {ask.state === 'answered' && ask.taskDelivery === 'failed' && (
          <p className="avatar-ask-warning" data-testid="avatar-ask-undelivered">{UNDELIVERED_TEXT}</p>
        )}
        {ask.state === 'answered' && ask.taskDelivery === 'skipped' && (
          <p className="avatar-ask-warning" data-testid="avatar-ask-not-typed">{NOT_TYPED_TEXT}</p>
        )}
      </li>
    );
  }

  const sending = submit?.status === 'sending';
  const refusal = submit?.status === 'refused' ? submit.message : null;
  const trimmed = text.trim();
  const locked = compact?.answersLocked === true;
  const answer = (choice: AskAnswerChoice): void => {
    if (sending || locked) return;
    onAnswer(ask.id, choice);
  };
  const onSubmitText = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!trimmed) return;
    answer({ text: trimmed });
  };

  const headContent = (
    <>
      <span className="avatar-mark-diamond" aria-hidden="true" />
      <span className="avatar-ask-who" title={who}>{who}</span>
      <span className="avatar-ask-time">{timeLeftText(ask.expiresAt, nowMs)}</span>
    </>
  );
  // In a list of folded rows the top line is the button that folds this card back into its row.
  const head = onCollapse ? (
    <button type="button" className="avatar-ask-head avatar-ask-toggle" onClick={onCollapse} aria-expanded="true" data-ask-toggle="" data-testid="avatar-ask-collapse">
      {headContent}
      <span className="avatar-ask-chevron" aria-hidden="true" />
    </button>
  ) : (
    <div className="avatar-ask-head">{headContent}</div>
  );

  return (
    <li className="avatar-ask avatar-ask-pending" tabIndex={-1} data-testid="avatar-ask" data-ask-id={ask.id} data-ask-state="pending">
      {head}
      <p
        className={`avatar-ask-question${compact && !showAll ? ' lucy-bubble-clamp' : ''}`}
        id={questionId}
        ref={questionRef}
        data-testid="avatar-ask-question"
      >{/* A card that appears by itself shows task text as plain text: no live link a stray click could follow. */}
        {compact ? ask.question : <TextWithLinks text={ask.question} />}
      </p>
      {compact && (overflowing || showAll) && (
        <button
          type="button"
          className="avatar-launch-link lucy-bubble-showall"
          onClick={() => setShowAll(!showAll)}
          aria-expanded={showAll}
          data-testid="avatar-ask-show-all"
        >
          {showAll ? 'Show less' : 'Show all'}
        </button>
      )}
      {!compact && ask.context && (
        <details className="avatar-ask-context">
          <summary>Background</summary>
          <p><TextWithLinks text={ask.context} /></p>
        </details>
      )}
      {!compact && (links.length > 0 || (onOpenTask && !ask.system)) && (
        // What the question is about, one click away: the pages it links to, and the task that asked.
        <div className="avatar-ask-links">
          {links.map((link, index) => (
            <a
              key={`${index}-${link.url}`}
              className="avatar-ask-link"
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              title={link.url}
              data-testid="avatar-ask-link"
            >
              {link.label ?? DEFAULT_ASK_LINK_LABEL}
            </a>
          ))}
          {onOpenTask && !ask.system && (
            <button
              type="button"
              className="avatar-ask-link"
              onClick={() => setOpenTaskFailed(!onOpenTask(ask.taskId))}
              data-testid="avatar-ask-open-task"
            >
              Open task
            </button>
          )}
        </div>
      )}
      {/* One group named by the question, so with several cards open each choice, text box and Send
          button is announced with the question it belongs to. */}
      <div className="avatar-ask-answers" role="group" aria-labelledby={questionId}>
      {compact && !optionsFitCompactCard(ask.options) ? (
        // Too many answers, or one too long to read on a small card: the full card has room for them.
        <button type="button" className="avatar-ask-option" onClick={compact.onOpenLucy} data-testid="avatar-ask-open-lucy">
          Open Lucy to answer
        </button>
      ) : (
      <div className="avatar-ask-options">
        {ask.options.map((label, index) => (
          <button
            key={`${index}-${label}`}
            type="button"
            className="avatar-ask-option"
            onClick={() => answer({ optionIndex: index })}
            // aria-disabled, like the panel's other buttons: focus stays put while the answer is on its way.
            aria-disabled={sending || locked ? 'true' : undefined}
            data-testid="avatar-ask-option"
          >
            {label}
          </button>
        ))}
      </div>
      )}
      {!compact && ask.allowText && (
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
        {sending ? 'Sending your answer…' : refusal ?? (openTaskFailed ? OPEN_TASK_FAILED_TEXT : 'Also on Telegram. The first answer wins.')}
      </p>
    </li>
  );
}
