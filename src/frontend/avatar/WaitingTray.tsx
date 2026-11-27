/**
 * "Waiting on you": the strip under Lucy's 3D view that holds everything a task is waiting on the operator
 * for, so that fifteen questions cost one line and not fifteen full cards.
 *
 * With nothing waiting it starts folded, as one line: "0 waiting on you · 2 opinions wanted". Pressing it unfolds
 * the list below; the choice is remembered until the browser tab is closed. While a question or a permission
 * prompt whose buttons still work is waiting, the strip is unfolded whatever was saved, with the question that
 * closes soonest open whole and the others as one line each, so a waiting question is never folded away. The
 * operator can fold it by hand (the saved choice is not touched); that holds until a NEW item arrives, and a
 * card they chose to open is never replaced by a newer one.
 *
 * Unfolded, from top to bottom:
 *  1. permission cards (`LucyPermissionCard.tsx`), as before;
 *  2. the questions a task may still be waiting for (`kookr ask`), the one that closes soonest first. Each is
 *     one line (who asks, the start of the question, the time left); pressing a line opens the whole card
 *     (`AskCard.tsx`) and folds the one that was open;
 *  3. one folded row for opinion requests: questions whose task has already ended, so nothing is blocked on
 *     them. Pressing it unfolds one line per question, again the one closing soonest first, and pressing a
 *     line opens that card. Only one card is open in the whole tray;
 *  4. questions that closed in the last few minutes, as the compact outcome row with Dismiss.
 *
 * The list is one scrolling area; a card never scrolls inside itself. The conversation below always keeps
 * 45% of the column, so the list takes what is left: the 3D view above gives up its height first, and only
 * when that is not enough does the list scroll. Its height changes over a moment, not at once, when it is
 * unfolded or a card opens. It is not shown when there is nothing to put in it. The count in the strip is
 * permissions plus questions a task may be waiting for: opinions are counted apart, because they block nothing.
 *
 * In Lucy's room (`rail`) the same tray is the side rail beside the conversation, and it has the room to show
 * things whole: it cannot be folded, every permission card and every question a task is waiting for is an
 * open card, and only the opinion requests stay folded under their one line. It scrolls by itself, its height
 * is not animated, and when nothing waits (opinion requests block nothing, so they do not count) it says so in
 * one quiet line instead of disappearing, so the rail keeps its place. The fold the operator chose for the strip is left alone and comes back with the column.
 *
 * It also keeps the three rules that stop a wrong answer being sent, which moved here with the cards:
 *  - a press on an answer is ignored for a moment after the cards change (a card closing, a row opening or
 *    folding, the list unfolding, a permission card arriving moves buttons under the pointer);
 *  - when the control that had keyboard focus goes away with its card, focus is put on what replaced it;
 *  - a card that is folded away keeps the answer being typed in it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import { dismissOperatorAsk, markAskSubmitting, type AskSubmitState } from '../store/operator-asks.js';
import { permissionButtonsLive, useLucyPermission } from '../store/lucy-permission.js';
import { loadTrayExpanded, saveTrayExpanded, useTrayOpenRequests } from '../store/avatar-panel-prefs.js';
import { AskCard, closesInText, timeLeftText, type AskAnswerChoice } from './AskCard.js';
import { LucyPermissionCards, type PermissionChoiceSender } from './LucyPermissionCard.js';

/** Answer presses are ignored for this long after the cards change, so a press aimed at a card that just moved cannot answer another question. */
export const ASK_PRESS_GUARD_MS = 400;

/** A little longer than the 150 ms the list's height takes to change (styles.css). */
const TRAY_SETTLE_MS = 180;
/** On the list while its content is taller than the room it has: only then may it scroll (styles.css). */
const SCROLLS_ATTRIBUTE = 'data-scrolls';
/** Where the browser cannot report sizes the list's height is never measured, so it may always scroll. */
const ALWAYS_SCROLLS = typeof ResizeObserver === 'undefined' ? { [SCROLLS_ATTRIBUTE]: '' } : {};

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
  /** True in Lucy's room, where the tray is the side rail: always unfolded, cards open, never hidden. */
  rail?: boolean;
}

export function WaitingTray({ asks, submit, nowMs, onAnswerAsk, onOpenTask, onPermissionChoice, dockRef, rail = false }: WaitingTrayProps) {
  const permissionCards = useLucyPermission().cards;
  const permissionCount = permissionCards.length;
  const pending = useMemo(() => asks.filter((ask) => ask.state === 'pending'), [asks]);
  const waiting = useMemo(() => pending.filter((ask) => ask.taskEnded !== true).sort(byExpiry), [pending]);
  const opinions = useMemo(() => pending.filter((ask) => ask.taskEnded === true).sort(byExpiry), [pending]);
  const closed = useMemo(() => asks.filter((ask) => ask.state !== 'pending'), [asks]);

  // Folded to one line until the operator unfolds it; remembered for this browser tab.
  const [expanded, setExpanded] = useState(loadTrayExpanded);
  // Something waits on the operator when a task has a question open or a permission prompt can still be answered
  // from here. Then the strip is unfolded whatever was saved (a question hidden behind a folded strip expired
  // unseen), and the soonest question is open. The operator can still fold it by hand; that holds until a NEW
  // item arrives. The saved choice is never changed by any of this.
  const livePermissionCount = permissionCards.filter((card) => permissionButtonsLive(card, Date.now())).length;
  const hasWaiting = waiting.length > 0 || livePermissionCount > 0;
  const [foldedByHand, setFoldedByHand] = useState(false);
  // Which cards are open: undefined until the operator chooses, then the id of a card, or null for "none".
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const trayOpenRequests = useTrayOpenRequests();
  const seenTrayOpenRequests = useRef(trayOpenRequests);
  useEffect(() => {
    // The dashboard's "Needs you" rows ask for it unfolded while the column is already open: a new reason to
    // unfold, even after the operator folded it by hand.
    if (trayOpenRequests !== seenTrayOpenRequests.current) {
      setExpanded(true);
      setFoldedByHand(false);
      setChosen((previous) => (previous === null ? undefined : previous));
    }
    seenTrayOpenRequests.current = trayOpenRequests;
  }, [trayOpenRequests]);
  const seenWaitingRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set([...waiting.map((ask) => `a:${ask.id}`), ...permissionCards.map((card) => `p:${card.promptId}`)]);
    const seen = seenWaitingRef.current;
    seenWaitingRef.current = ids;
    if (seen === null || ![...ids].some((id) => !seen.has(id))) return;
    // A new item: the strip comes back, and "all folded" gives way to the soonest question. An open card the operator chose stays.
    setFoldedByHand(false);
    setChosen((previous) => (previous === null ? undefined : previous));
  }, [waiting, permissionCards]);
  // A permission prompt is the one thing that unfolds the strip by itself: a task is stopped on it and Lucy
  // has just said "the command is on my card", so Approve and Deny must be on screen. The remembered choice
  // is not changed, and the operator can fold it away again.
  const seenPermissionCount = useRef(permissionCount);
  useEffect(() => {
    if (permissionCount > seenPermissionCount.current) setExpanded(true);
    seenPermissionCount.current = permissionCount;
  }, [permissionCount]);
  // The strip that opened for a waiting question stays open while the outcome of it ("You answered: ...") is on
  // show, unless the operator folded it: folding it as the question closes would hide the very thing they pressed for.
  const [openedForWaiting, setOpenedForWaiting] = useState(false);
  const hasClosed = asks.some((ask) => ask.state !== 'pending');
  useEffect(() => {
    setOpenedForWaiting(hasWaiting ? !foldedByHand : openedForWaiting && hasClosed && !foldedByHand);
  }, [hasWaiting, foldedByHand, hasClosed, openedForWaiting]);
  const stripOpen = hasWaiting ? !foldedByHand : expanded || openedForWaiting;
  const [opinionsOpen, setOpinionsOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const trayRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollToRef = useRef<string | null>(null);

  const pendingIds = useMemo(() => new Set(pending.map((ask) => ask.id)), [pending]);
  // The open card: the one the operator chose; before they choose, the question that closes soonest. One that
  // went away (answered, expired) leaves the choice to the soonest again, so a waiting question is never folded.
  const expandedId = chosen === null
    ? null
    : chosen !== undefined && pendingIds.has(chosen)
      ? chosen
      : (waiting[0]?.id ?? null);
  useLayoutEffect(() => {
    if (chosen !== undefined && chosen !== null && !pendingIds.has(chosen)) setChosen(undefined);
    // The soonest question, opened for the operator, is theirs from now on: a later one that closes sooner does not take its place.
    else if (chosen === undefined && waiting[0]) setChosen(waiting[0].id);
  }, [chosen, pendingIds, waiting]);

  // After the cards change: a press that lands in the next moment may have been aimed at a card that is no
  // longer under the pointer, so it is ignored (the operator presses again).
  const cardsChangedAtRef = useRef(0);
  // Permission cards sit above the questions in the same scroll box: one arriving or leaving moves the buttons too.
  // Entering or leaving the room lays everything out again, so it counts as a change too.
  const signature = `${asks.map((ask) => `${ask.id}:${ask.state}`).join(',')}|${expandedId ?? ''}|${opinionsOpen ? 'o' : ''}|${permissionCards.map((card) => card.promptId).join(',')}|${stripOpen ? 'x' : ''}|${rail ? 'r' : ''}`;
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
      // The list was folded away with the control in it: the strip that folded it is what is left.
      ?? toggleRef.current
      ?? dockRef.current;
    target?.focus();
  }, [signature, dockRef]);

  const showOpenCard = useCallback((): void => {
    const id = expandedId;
    if (id === null) return;
    trayRef.current?.querySelector<HTMLElement>(`[data-testid="avatar-ask"][data-ask-id="${id}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [expandedId]);

  // A card the operator just opened is brought fully into view inside the tray.
  useLayoutEffect(() => {
    const id = scrollToRef.current;
    if (id === null || id !== expandedId) return;
    scrollToRef.current = null;
    showOpenCard();
  });

  // The list is as tall as its content, and gets there over a moment (the transition is in styles.css) so that
  // unfolding it or opening a card does not make the column jump. Its height is written here because a height of
  // "auto" cannot be animated. Once the height has settled, two things are decided from what is really on screen:
  // whether the list needs to scroll (only then does it get a scrollbar, so none flashes while the height is on
  // its way), and the open card is brought whole into view in the room there now is.
  const showOpenCardRef = useRef(showOpenCard);
  showOpenCardRef.current = showOpenCard;
  // The rail in Lucy's room is always there; the strip only while something is in it.
  const shown = rail || permissionCount > 0 || asks.length > 0;
  useEffect(() => {
    const body = bodyRef.current;
    const list = listRef.current;
    // The rail has the height the room gives it and scrolls by itself (styles.css): nothing to measure.
    if (!shown || rail || !body || !list || typeof ResizeObserver === 'undefined') return undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      const height = `${list.offsetHeight}px`;
      if (body.style.height !== height) body.style.height = height;
      clearTimeout(settle);
      settle = setTimeout(() => {
        body.toggleAttribute(SCROLLS_ATTRIBUTE, list.offsetHeight > body.clientHeight + 1);
        showOpenCardRef.current();
      }, TRAY_SETTLE_MS);
    });
    // The list: its content changed. The box: the column gave it more or less room (a resized window, the composer growing).
    observer.observe(list);
    observer.observe(body);
    return () => {
      observer.disconnect();
      clearTimeout(settle);
      // Nothing measured may stay behind: the rail must not inherit the strip's height.
      body.style.height = '';
      body.removeAttribute(SCROLLS_ATTRIBUTE);
    };
  }, [shown, rail]);

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

  if (!shown) return null;

  const waitingCount = permissionCount + waiting.length;
  const toggle = (): void => {
    if (hasWaiting) {
      // The saved choice is for when nothing waits; by hand, only this wait is folded or unfolded.
      setFoldedByHand(stripOpen);
      return;
    }
    setExpanded(!expanded);
    saveTrayExpanded(!expanded);
  };
  const listLabel = waiting.length > 0
    ? `Questions waiting for your answer (${waiting.length})`
    : opinions.length > 0
      ? `Opinion requests (${opinions.length})`
      : 'Recent questions';

  const renderRow = (ask: OperatorAskView, kind: 'waiting' | 'opinion') => {
    const who = ask.system ? 'Kookr asks' : ask.taskName ? `${ask.taskName} asks` : 'A task asks';
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
    // In the rail a question a task is waiting for is always an open card, and has no line to fold back to.
    const alwaysOpen = rail && kind === 'waiting';
    if (!alwaysOpen && ask.id !== expandedId) return renderRow(ask, kind);
    return (
      <AskCard
        key={ask.id}
        ask={ask}
        submit={submit[ask.id]}
        nowMs={nowMs}
        onAnswer={onAnswer}
        onDismiss={dismissOperatorAsk}
        {...(alwaysOpen ? {} : { onCollapse: () => setChosen(null) })}
        draft={{ value: drafts[ask.id] ?? '', set: (value) => setDrafts((previous) => ({ ...previous, [ask.id]: value })) }}
        {...(onOpenTask ? { onOpenTask } : {})}
      />
    );
  };

  return (
    <section
      className={`avatar-tray${waitingCount > 0 ? ' avatar-tray-waiting' : ''}${rail ? ' avatar-tray-rail' : ''}`}
      aria-label="Waiting on you"
      ref={trayRef}
      data-testid="avatar-tray"
    >
      {rail ? (
        // The rail cannot be folded, so its top line is a title, not a button.
        <div className="avatar-tray-title" data-testid="avatar-tray-title">
          <h2 className="avatar-tray-heading">Waiting on you</h2>
          {waitingCount > 0 && (
            // The number alone means nothing to a screen reader; the unit is said, not shown.
            <span className="avatar-tray-count" data-testid="avatar-tray-count">{waitingCount}<span className="sr-only"> waiting</span></span>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="avatar-tray-head"
          aria-expanded={stripOpen}
          aria-controls="avatar-tray-body"
          onClick={toggle}
          ref={toggleRef}
          data-testid="avatar-tray-toggle"
        >
          <span className="avatar-tray-summary">
            <span className="avatar-tray-count" data-testid="avatar-tray-count">{waitingCount}</span> waiting on you
            {opinions.length > 0 && (
              <span className="avatar-tray-opinions" data-testid="avatar-tray-opinions"> · {plural(opinions.length, 'opinion', 'opinions')} wanted</span>
            )}
          </span>
          <span className="avatar-ask-chevron" aria-hidden="true" />
        </button>
      )}
      <div
        className="avatar-tray-body"
        id="avatar-tray-body"
        ref={bodyRef}
        {...ALWAYS_SCROLLS}
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
        {/* Its natural height is what the box above is given (see the effect that measures it). */}
        <div className="avatar-tray-list" ref={listRef}>
          {/* Opinion requests block nothing, so with only those left nothing is waiting either. */}
          {rail && waitingCount === 0 && (
            <p className="avatar-tray-empty" data-testid="avatar-tray-empty">Nothing is waiting on you.</p>
          )}
          {(stripOpen || rail) && (
            <>
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
            </>
          )}
        </div>
      </div>
    </section>
  );
}
