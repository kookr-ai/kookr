/**
 * "Waiting on you": the short tray under Lucy's 3D view that holds everything a task is waiting on the
 * operator for, so that fifteen questions cost a few lines and not fifteen full cards.
 *
 * From top to bottom:
 *  1. permission cards (`LucyPermissionCard.tsx`), as before;
 *  2. the questions a task may still be waiting for (`kookr ask`), the one that closes soonest first. Each is
 *     one line (who asks, the start of the question, the time left); pressing a line opens the whole card
 *     (`AskCard.tsx`) and folds the one that was open. The first one is open by default;
 *  3. one folded row for opinion requests: questions whose task has already ended, so nothing is blocked on
 *     them. Pressing it unfolds one line per question, again the one closing soonest first, and pressing a
 *     line opens that card. Only one card is open in the whole tray;
 *  4. questions that closed in the last few minutes, as the compact outcome row with Dismiss.
 *
 * The tray takes at most half the column and scrolls inside itself beyond that; it is not shown when there
 * is nothing to put in it. The count in its header is permissions plus questions a task may be waiting for:
 * opinions are counted in their own row, because they block nothing.
 *
 * It also keeps the three rules that stop a wrong answer being sent, which moved here with the cards:
 *  - a press on an answer is ignored for a moment after the cards change (a card closing, a row opening or
 *    folding, a permission card arriving moves buttons under the pointer);
 *  - when the control that had keyboard focus goes away with its card, focus is put on what replaced it;
 *  - a card that is folded away keeps the answer being typed in it.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import { dismissOperatorAsk, markAskSubmitting, type AskSubmitState } from '../store/operator-asks.js';
import { useLucyPermission } from '../store/lucy-permission.js';
import { AskCard, closesInText, timeLeftText, type AskAnswerChoice } from './AskCard.js';
import { LucyPermissionCards, type PermissionChoiceSender } from './LucyPermissionCard.js';

/** Answer presses are ignored for this long after the cards change, so a press aimed at a card that just moved cannot answer another question. */
export const ASK_PRESS_GUARD_MS = 400;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The soonest-closing question first; ties keep the order the server sent them in. */
function byExpiry(a: OperatorAskView, b: OperatorAskView): number {
  return a.expiresAt - b.expiresAt;
}

export interface WaitingTrayProps {
  /** The questions to show: every pending one and the recently closed ones. */
  asks: readonly OperatorAskView[];
  submit: Readonly<Record<string, AskSubmitState>>;
  /** The server's clock now, for the "N min left" labels. */
  nowMs: number;
  /** Send an answer over the dashboard socket; false when it could not be sent. Absent: an answer reports "not connected". */
  onAnswerAsk?: (askId: string, choice: AskAnswerChoice) => boolean;
  onOpenTask?: (taskId: string) => boolean;
  onPermissionChoice?: PermissionChoiceSender;
  /** The column itself: where keyboard focus goes when a question's card is gone and nothing replaced it. */
  dockRef: RefObject<HTMLElement | null>;
}

export function WaitingTray({ asks, submit, nowMs, onAnswerAsk, onOpenTask, onPermissionChoice, dockRef }: WaitingTrayProps) {
  const permissionCards = useLucyPermission().cards;
  const permissionCount = permissionCards.length;
  const pending = useMemo(() => asks.filter((ask) => ask.state === 'pending'), [asks]);
  const waiting = useMemo(() => pending.filter((ask) => ask.taskEnded !== true).sort(byExpiry), [pending]);
  const opinions = useMemo(() => pending.filter((ask) => ask.taskEnded === true).sort(byExpiry), [pending]);
  const closed = useMemo(() => asks.filter((ask) => ask.state !== 'pending'), [asks]);

  // Which card is open: undefined until the operator chooses, then the id, or null for "none". A question
  // that arrives later never takes the place of the open one (that would throw away a half-typed answer).
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const [opinionsOpen, setOpinionsOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const trayRef = useRef<HTMLElement | null>(null);
  const scrollToRef = useRef<string | null>(null);

  const pendingIds = useMemo(() => new Set(pending.map((ask) => ask.id)), [pending]);
  const firstWaitingId = waiting[0]?.id ?? null;
  // The open card went away (answered, expired): the choice is forgotten, so the next question to arrive is open by default.
  const chosenIsStale = chosen !== undefined && chosen !== null && !pendingIds.has(chosen);
  // Nothing chosen yet (or the chosen one is gone): the first waiting question is open.
  const expandedId = chosen === null ? null : chosen !== undefined && !chosenIsStale ? chosen : firstWaitingId;
  // Make what is shown the operator's choice from now on, so a question arriving later cannot move it.
  useLayoutEffect(() => {
    if (chosenIsStale) setChosen(undefined);
    else if (chosen === undefined && expandedId !== null) setChosen(expandedId);
  }, [chosen, chosenIsStale, expandedId]);

  // After the cards change: a press that lands in the next moment may have been aimed at a card that is no
  // longer under the pointer, so it is ignored (the operator presses again).
  const cardsChangedAtRef = useRef(0);
  // Permission cards sit above the questions in the same scroll box: one arriving or leaving moves the buttons too.
  const signature = `${asks.map((ask) => `${ask.id}:${ask.state}`).join(',')}|${expandedId ?? ''}|${opinionsOpen ? 'o' : ''}|${permissionCards.map((card) => card.promptId).join(',')}`;
  useLayoutEffect(() => {
    cardsChangedAtRef.current = Date.now();
  }, [signature]);

  // The control inside a card that holds keyboard focus, and its question. A card is replaced when its question
  // closes or its row is pressed, and removed when dismissed; the focused control then disappears and the
  // browser drops focus to the top of the page. Only that case is repaired. Two rules keep this from ever doing
  // harm: it acts only when that control really left the page and focus fell to the document (focus the
  // operator moved elsewhere is never taken back), and it lands on the card's top line or the card itself,
  // never on an answer button, so a stray Enter or Space cannot send an answer.
  const focusedControlRef = useRef<{ element: HTMLElement; askId: string } | null>(null);
  useLayoutEffect(() => {
    const focused = focusedControlRef.current;
    if (!focused || focused.element.isConnected) return;
    focusedControlRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const tray = trayRef.current;
    const target = tray?.querySelector<HTMLElement>(`[data-ask-id="${focused.askId}"] [data-ask-toggle]`)
      ?? tray?.querySelector<HTMLElement>(`[data-ask-id="${focused.askId}"]`)
      ?? dockRef.current;
    target?.focus();
  }, [signature, dockRef]);

  // A card the operator just opened is brought fully into view inside the tray.
  useLayoutEffect(() => {
    const id = scrollToRef.current;
    if (id === null || id !== expandedId) return;
    scrollToRef.current = null;
    trayRef.current?.querySelector<HTMLElement>(`[data-testid="avatar-ask"][data-ask-id="${id}"]`)?.scrollIntoView?.({ block: 'nearest' });
  });

  const onAnswer = useCallback((askId: string, choice: AskAnswerChoice) => {
    // A clock that stepped backwards (negative elapsed time) must not keep answers blocked.
    const sinceChange = Date.now() - cardsChangedAtRef.current;
    if (sinceChange >= 0 && sinceChange < ASK_PRESS_GUARD_MS) return;
    markAskSubmitting(askId, onAnswerAsk ? onAnswerAsk(askId, choice) : false);
  }, [onAnswerAsk]);

  const open = (askId: string): void => {
    scrollToRef.current = askId;
    setChosen(askId);
  };

  if (permissionCount === 0 && asks.length === 0) return null;

  const waitingCount = permissionCount + waiting.length;
  const listLabel = waiting.length > 0
    ? `Questions waiting for your answer (${waiting.length})`
    : opinions.length > 0
      ? `Opinion requests (${opinions.length})`
      : 'Recent questions';

  const renderRow = (ask: OperatorAskView, kind: 'waiting' | 'opinion') => {
    const who = ask.taskName ? `${ask.taskName} asks` : 'A task asks';
    return (
      <li className={`avatar-ask-row-item${kind === 'opinion' ? ' avatar-ask-row-opinion' : ''}`} key={ask.id} data-ask-id={ask.id}>
        <button
          type="button"
          className="avatar-ask-row"
          aria-expanded="false"
          onClick={() => open(ask.id)}
          data-ask-toggle=""
          data-testid="avatar-ask-row"
        >
          <span className={kind === 'opinion' ? 'avatar-mark-ring' : 'avatar-mark-diamond'} aria-hidden="true" />
          <span className="avatar-ask-row-who">{who}</span>{' '}
          <span className="avatar-ask-row-question">{ask.question}</span>
          <span className="avatar-ask-time">{timeLeftText(ask.expiresAt, nowMs)}</span>
          <span className="avatar-ask-chevron" aria-hidden="true" />
        </button>
      </li>
    );
  };

  const renderEntry = (ask: OperatorAskView, kind: 'waiting' | 'opinion') => {
    if (ask.id !== expandedId) return renderRow(ask, kind);
    return (
      <AskCard
        key={ask.id}
        ask={ask}
        submit={submit[ask.id]}
        nowMs={nowMs}
        onAnswer={onAnswer}
        onDismiss={dismissOperatorAsk}
        onCollapse={() => setChosen(null)}
        draft={{ value: drafts[ask.id] ?? '', set: (value) => setDrafts((previous) => ({ ...previous, [ask.id]: value })) }}
        {...(onOpenTask ? { onOpenTask } : {})}
      />
    );
  };

  return (
    <section className="avatar-tray" aria-label="Waiting on you" ref={trayRef} data-testid="avatar-tray">
      <div className="avatar-tray-head">
        <span>Waiting on you</span>
        <span className="avatar-tray-count" data-testid="avatar-tray-count">{waitingCount}</span>
      </div>
      <div
        className="avatar-tray-body"
        onFocus={(event) => {
          const element = event.target as HTMLElement;
          const askId = element.closest<HTMLElement>('[data-ask-id]')?.dataset.askId;
          focusedControlRef.current = askId ? { element, askId } : null;
        }}
        onBlur={(event) => {
          // A control that is still in the page lost focus because the operator moved it (another field, a click on
          // the page, another window): forget it. A control removed while focused is no longer in the page here, or
          // never reports a blur at all; that is the case the effect above repairs.
          if ((event.target as HTMLElement).isConnected) focusedControlRef.current = null;
        }}
      >
        <LucyPermissionCards
          {...(onPermissionChoice ? { onChoice: onPermissionChoice } : {})}
          {...(onOpenTask ? { onOpenTask } : {})}
        />
        {(asks.length > 0) && (
          <ol
            className="avatar-asks"
            // Stated because `list-style: none` makes some browsers drop the list role, and its label with it.
            role="list"
            aria-label={listLabel}
            data-testid="avatar-asks"
          >
            {waiting.map((ask) => renderEntry(ask, 'waiting'))}
            {opinions.length > 0 && (
              <li className="avatar-opinions" data-testid="avatar-opinions">
                <button
                  type="button"
                  className="avatar-ask-row avatar-opinions-toggle"
                  aria-expanded={opinionsOpen}
                  aria-controls={opinionsOpen ? 'avatar-opinion-list' : undefined}
                  onClick={() => setOpinionsOpen((value) => !value)}
                  data-testid="avatar-opinions-toggle"
                >
                  <span className="avatar-mark-ring" aria-hidden="true" />
                  {/* May wrap onto a second line: the whole sentence, with when the first closes, matters more than one line. */}
                  <span className="avatar-opinions-text">
                    {plural(opinions.length, 'opinion', 'opinions')} wanted by finished {opinions.length === 1 ? 'task' : 'tasks'}
                    <span className="avatar-opinions-first"> · first closes in {closesInText(opinions[0].expiresAt, nowMs)}</span>
                  </span>
                  <span className="avatar-ask-chevron" aria-hidden="true" />
                </button>
                {opinionsOpen && (
                  <ol className="avatar-asks avatar-opinion-list" role="list" id="avatar-opinion-list" aria-label={`Opinion requests (${opinions.length})`} data-testid="avatar-opinion-list">
                    {opinions.map((ask) => renderEntry(ask, 'opinion'))}
                  </ol>
                )}
              </li>
            )}
            {closed.map((ask) => (
              <AskCard
                key={ask.id}
                ask={ask}
                submit={submit[ask.id]}
                nowMs={nowMs}
                onAnswer={onAnswer}
                onDismiss={dismissOperatorAsk}
                {...(onOpenTask ? { onOpenTask } : {})}
              />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
