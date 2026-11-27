/**
 * Which decision the minimised bubble grows into, and when (`BubbleDecisionCard.tsx` draws it).
 *
 * While Lucy is a 58 px bubble, a question from a task (`kookr ask`) or a permission prompt whose buttons still
 * work shows as a card beside the bubble, so the operator does not have to open her to see that something is
 * waiting. This file decides only the "which" and the "when"; it never sends an answer.
 *
 *  - Which: a live permission prompt first, then the question that closes soonest. One card at a time; the
 *    card on screen keeps its place until it is answered, put off ("Later") or opened in the column, and
 *    whatever arrives meanwhile waits its turn. Opinion requests (the task has ended) never grow the bubble.
 *  - Once per item: an item grows the bubble once in this browser tab. It counts from the moment it was
 *    really on screen (not while the tab is hidden, Do Not Disturb is on or the operator is typing), is kept
 *    in `sessionStorage` (at most {@link MAX_REMEMBERED} ids), and "Later" or an answer never brings it back.
 *  - Never in the way: it waits while a key was pressed in the last {@link TYPING_QUIET_MS} (or focus moved
 *    into a text field or a terminal), while the tab is hidden, and while Do Not Disturb is on. It never takes
 *    keyboard focus; the panel announces it through its polite status region.
 *  - Outcomes: when the question on screen closes (answered here or on Telegram, expired, withdrawn) the card
 *    stays {@link OUTCOME_VISIBLE_MS} and says what happened, then the next item or the bubble.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { LucyPermissionCardView } from '../../shared/contracts/lucy-permission.js';
import { useDnd } from '../hooks/useDnd.js';
import { permissionButtonsLive, useLucyPermission } from '../store/lucy-permission.js';
import { askOutcome } from './AskCard.js';

/** A key pressed this recently means the operator is typing: the card waits for 2 s of quiet. */
export const TYPING_QUIET_MS = 2000;
/** How long the card says what happened to a question or prompt before moving on. */
export const OUTCOME_VISIBLE_MS = 4000;
/** Most item ids remembered as "already grew the bubble" (the oldest are forgotten first). */
export const MAX_REMEMBERED = 200;

export const BUBBLE_GROWN_KEY = 'kookr:lucyBubbleGrown';

export type BubbleItem =
  | { kind: 'ask'; key: string; ask: OperatorAskView }
  | { kind: 'permission'; key: string; card: LucyPermissionCardView };

/** What the card on screen says about its item having ended. */
export interface BubbleOutcome {
  text: string;
  answered: boolean;
}

// --- the ids that already grew the bubble ---

/** Kept only when `sessionStorage` cannot be used. */
let memory: string[] = [];

function readGrown(): string[] {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(BUBBLE_GROWN_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return memory;
  }
}

/** Whether this item already grew the bubble in this tab. */
export function hasGrown(key: string): boolean {
  return readGrown().includes(key);
}

function markGrown(key: string): void {
  const ids = readGrown().filter((id) => id !== key);
  ids.push(key);
  const kept = ids.slice(-MAX_REMEMBERED);
  memory = kept;
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(BUBBLE_GROWN_KEY, JSON.stringify(kept));
  } catch {
    // Kept in memory for this page load.
  }
}

export function __resetBubbleDecisionForTests(): void {
  memory = [];
}

// --- which items wait ---

export const askKey = (ask: OperatorAskView): string => `a:${ask.id}`;
export const permissionKey = (card: LucyPermissionCardView): string => `p:${card.promptId}`;

/** A permission prompt grows the bubble only while one of its buttons can still answer it. */
function permissionIsLive(card: LucyPermissionCardView, nowMs: number): boolean {
  return permissionButtonsLive(card, nowMs) && Boolean(card.approveKey || card.denyKey);
}

/** Questions a task may still be waiting for, the one that closes soonest first (ties keep the server's order). */
function waitingAsks(asks: readonly OperatorAskView[]): OperatorAskView[] {
  return asks
    .filter((ask) => ask.state === 'pending' && ask.taskEnded !== true)
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

/** Every item that waits on the operator right now, in the order the card takes them: prompts, then questions. */
export function waitingItems(asks: readonly OperatorAskView[], cards: readonly LucyPermissionCardView[], nowMs: number): BubbleItem[] {
  const prompts = cards
    .filter((card) => permissionIsLive(card, nowMs))
    .sort((a, b) => a.since - b.since)
    .map((card): BubbleItem => ({ kind: 'permission', key: permissionKey(card), card }));
  return [...prompts, ...waitingAsks(asks).map((ask): BubbleItem => ({ kind: 'ask', key: askKey(ask), ask }))];
}

// --- is the operator busy ---

/** A text field or a terminal (xterm keeps a hidden textarea): typing there is what the card must not interrupt. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest('input, textarea, select, .xterm') !== null;
}

export interface UseBubbleDecisionOptions {
  /** The panel is the bubble. The card exists only then. */
  minimized: boolean;
  /** Every question the panel knows, closed ones included (the closed one on screen says how it ended). */
  asks: readonly OperatorAskView[];
  /** A modal dialog is open over the page: the card does not appear then (the Dock hides one already up). */
  blocked?: boolean;
  /** Called once when an item first appears, for the announcement and the log. */
  onShown?: (item: BubbleItem) => void;
}

export interface BubbleDecision {
  /** The item on the card, or null when the bubble is just the bubble. */
  item: BubbleItem | null;
  /** Set once the item ended while on screen: the card then says this instead of its question. */
  outcome: BubbleOutcome | null;
  /** How many other things wait on the operator. */
  moreCount: number;
  /** The browser's clock, ticking once a second while the card is up. */
  nowMs: number;
  /** Note which button the operator pressed on a prompt's card, so its outcome can say it ("Approve once"). */
  rememberChoice: (key: string, label: string) => void;
  /** "Later": put the card away. The item will not grow the bubble again in this tab. */
  dismiss: () => void;
}

export function useBubbleDecision({ minimized, asks, blocked = false, onShown }: UseBubbleDecisionOptions): BubbleDecision {
  const { cards, pressed } = useLucyPermission();
  const dnd = useDnd().enabled;
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [quiet, setQuiet] = useState(true);
  const [tabVisible, setTabVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const lastActivityRef = useRef(0);
  // The prompt buttons the operator pressed here, to word the outcome.
  const pressedChoiceRef = useRef(new Map<string, string>());
  // The last live view of the prompt on the card, to say how it ended once the server's list no longer has it.
  const lastPermissionRef = useRef<Extract<BubbleItem, { kind: 'permission' }> | null>(null);
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;

  // Busy: a key pressed, or focus moved into a text field or a terminal, in the last two seconds.
  useEffect(() => {
    if (!minimized) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      clearTimeout(timer);
      const left = lastActivityRef.current + TYPING_QUIET_MS - Date.now();
      if (left > 0) {
        setQuiet(false);
        timer = setTimeout(settle, left);
      } else {
        setQuiet(true);
      }
    };
    const onKey = (): void => {
      lastActivityRef.current = Date.now();
      settle();
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (!isTypingTarget(event.target)) return;
      lastActivityRef.current = Date.now();
      settle();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn, true);
    settle();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [minimized]);

  useEffect(() => {
    const onVisibility = (): void => setTabVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Fresh while waiting for a card to appear is not needed (the panel re-renders on every change); while one is up its
  // clock ticks, for "N min left" and for a prompt's buttons timing out.
  useEffect(() => {
    if (shownKey === null) return undefined;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [shownKey]);

  const now = shownKey === null ? Date.now() : nowMs;
  const waiting = useMemo(() => waitingItems(asks, cards, now), [asks, cards, now]);

  // The item on the card, found again in the current lists on every render so it shows what is true now.
  const current = useMemo((): { item: BubbleItem | null; outcome: BubbleOutcome | null; gone: boolean } => {
    if (shownKey === null) return { item: null, outcome: null, gone: false };
    if (shownKey.startsWith('a:')) {
      const ask = asks.find((a) => askKey(a) === shownKey);
      if (!ask) return { item: null, outcome: null, gone: true };
      const item: BubbleItem = { kind: 'ask', key: shownKey, ask };
      return { item, outcome: ask.state === 'pending' ? null : askOutcome(ask), gone: false };
    }
    const card = cards.find((c) => permissionKey(c) === shownKey);
    if (!card) {
      const chosen = pressedChoiceRef.current.get(shownKey);
      const last = lastPermissionRef.current;
      if (!last || last.key !== shownKey) return { item: null, outcome: null, gone: true };
      return {
        item: last,
        outcome: { text: chosen ? `You chose ${chosen}` : 'Answered in the task', answered: Boolean(chosen) },
        gone: false,
      };
    }
    // The buttons timed out while the card was up: it is not an outcome, the prompt still waits in the task.
    if (!permissionIsLive(card, now) && !pressed.has(card.promptId)) return { item: null, outcome: null, gone: true };
    return { item: { kind: 'permission', key: shownKey, card }, outcome: null, gone: false };
  }, [shownKey, asks, cards, pressed, now]);
  if (current.item?.kind === 'permission' && current.outcome === null) lastPermissionRef.current = current.item;

  const canShow = minimized && !dnd && tabVisible && quiet && !blocked;

  // Nothing on the card: take the first waiting item that has not grown the bubble yet.
  useEffect(() => {
    if (shownKey !== null || !canShow) return;
    const next = waiting.find((item) => !hasGrown(item.key));
    if (!next) return;
    markGrown(next.key);
    setShownKey(next.key);
    onShownRef.current?.(next);
  }, [shownKey, canShow, waiting]);

  // The card goes when the panel opens, Do Not Disturb goes on, or the item ended with nothing to say.
  useEffect(() => {
    if (shownKey !== null && (!minimized || dnd || current.gone)) setShownKey(null);
  }, [shownKey, minimized, dnd, current.gone]);

  // An item that ended while on screen says so for a few seconds, then the next one (or the bubble).
  // The 4 seconds count only while the card can be seen: not with the tab hidden or a dialog over the page.
  const ended = current.outcome !== null;
  const onScreen = tabVisible && !blocked;
  useEffect(() => {
    if (shownKey === null || !ended || !onScreen) return undefined;
    const timer = setTimeout(() => setShownKey(null), OUTCOME_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [shownKey, ended, onScreen]);

  const dismiss = useCallback(() => setShownKey(null), []);
  const rememberChoice = useCallback((key: string, label: string) => { pressedChoiceRef.current.set(key, label); }, []);

  const moreCount = waiting.filter((item) => item.key !== current.item?.key).length;
  return { item: current.item, outcome: current.outcome, moreCount, nowMs: now, rememberChoice, dismiss };
}
