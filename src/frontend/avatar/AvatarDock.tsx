/**
 * The optional avatar panel: a small floating window, by default in the
 * bottom-right corner, showing a 3D character who lip-syncs Kookr's spoken
 * summaries (the clips played by the speaker buttons on tasks).
 *
 * It can be dragged by its title bar and minimised to a round bubble. While
 * minimised the 3D view is shut down completely, and the bubble shows a still
 * image, so a minimised panel uses no GPU. Hovering or focusing the bubble
 * shows a small card that spells out what its badge and dot mean.
 *
 * A "Talk" button in the header switches on hands-free conversation with Lucy
 * (`lucy-live/useLucyLive.ts`): she listens through the microphone, answers out loud
 * and can be interrupted by speaking over her. It lives in this component, not in the
 * 3D view, so it keeps running while the panel is minimised, and it is never saved:
 * every page load starts with the microphone closed.
 *
 * When a task asks the operator a question (`kookr ask`, the same question that
 * goes to Telegram), Lucy reads it out once and the panel shows it as a card with
 * one button per choice (`AskCard.tsx`). Answering there closes the question on
 * Telegram too, and an answer given on Telegram turns the card into "Answered on
 * Telegram". While minimised, the bubble's badge counts the waiting questions.
 *
 * Under the 3D view the panel lists the last few spoken messages in full (what, about
 * which task, how long ago, heard or not), each with its own Replay button. The list is
 * a keyboard-focusable scroll region, so a long message is read by scrolling, not cut off.
 *
 * This file and everything it imports (three.js, the avatar file) is loaded
 * only when the operator has switched the panel on — see the lazy import in
 * App.tsx and `store/avatar-panel-prefs.ts`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent } from 'react';
import { formatRelativeTime } from './relative-time.js';
import avatarUrl from './assets/lucy-bust.glb?url';
import { AvatarStage, type AvatarState } from './avatar-stage.js';
import { subscribeSpeechBus } from '../audio/speech-bus.js';
import { getLastClip, useClipHistory, useLastClip } from '../audio/last-clip.js';
import { replayClip, replayLastClip, stopReplay, type ReplayResult } from '../audio/clip-playback.js';
import { useSoundPreference } from '../audio/sound-preference.js';
import { track } from '../telemetry.js';
import { announceAsk, stopAskAnnouncement } from '../audio/ask-announcement.js';
import {
  dismissOperatorAsk,
  markAskSubmitting,
  onAskAnnounced,
  onAskClosed,
  useOperatorAsks,
  visibleOperatorAsks,
} from '../store/operator-asks.js';
import { AskCard, type AskAnswerChoice } from './AskCard.js';
import { SOUND_OFF_REASON, useLucyLive } from '../lucy-live/useLucyLive.js';
import type { LucyLiveState } from '../../shared/contracts/lucy-live.js';
import {
  AVATAR_BUBBLE_SIZE,
  AVATAR_PANEL_HEIGHT,
  AVATAR_PANEL_MARGIN,
  AVATAR_PANEL_WIDTH,
  clampAvatarPanelPosition,
  defaultAvatarPanelPosition,
  updateAvatarPanelPrefs,
  useAvatarPanelPrefs,
} from '../store/avatar-panel-prefs.js';

const NAME = 'Lucy';
const STATE_LABEL: Record<AvatarState, string> = {
  idle: 'ready',
  thinking: 'preparing',
  speaking: 'speaking',
};
const IDLE_HINT = 'Press a speaker button on a task and I will read its summary to you.';
const LIVE_HINT = 'Talk to me \u2014 I\u2019m listening.';
/** What the state label says while hands-free is on, from what the server reports Lucy is doing. */
const LIVE_STATE_LABEL: Record<LucyLiveState, string> = {
  idle: 'listening',
  listening: 'listening',
  transcribing: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
};
/** The Talk button's accessible name; constant, because `aria-pressed` carries on/off. */
const TALK_LABEL = `Talk to ${NAME} hands-free`;
const TALK_STOP_LABEL = 'Stop hands-free';
const TALK_REASON_ID = 'avatar-talk-reason';
const REPLAY_LABEL = 'Replay last message';
/** Re-render the "N min ago" labels this often while the message list is on screen. */
const RELATIVE_TIME_REFRESH_MS = 30_000;

/** Shown in the status region when a replay could not start; the three other results need no message. */
const REPLAY_MUTED_TITLE = 'Sound is off in Settings';

const REPLAY_NOTICE: Partial<Record<ReplayResult, string>> = {
  muted: 'Sound is off in Settings, so the message was not replayed.',
  blocked: 'Your browser blocked audio. Press Replay again to allow it.',
  error: 'The message could not be played again.',
};

function trackPanelAction(action: 'minimize' | 'restore' | 'move' | 'replay', replayedClipId?: string): void {
  const clipId = replayedClipId ?? getLastClip()?.clipId;
  track({ type: 'lucy_panel_action', action, ...(clipId ? { clipId } : {}) });
}

function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

export interface AvatarDockProps {
  /** How many tasks are waiting for the operator; shown as a badge on the bubble. */
  attentionCount: number;
  /**
   * Send the operator's answer to a `kookr ask` question over the dashboard socket.
   * Returns false when it could not be sent (not connected). Without it the cards are
   * still shown, and an answer reports "not connected".
   */
  onAnswerAsk?: (askId: string, choice: AskAnswerChoice) => boolean;
}

const REPLAY_DESCRIPTION_ID = 'avatar-replay-description';
/** Why the per-message Replay buttons are unavailable; they point at this text while they are. */
const REPLAY_REASON_ID = 'avatar-replay-reason';

/** True when the browser would draw a focus ring, i.e. focus came from the keyboard; true when it cannot tell. */
function matchesFocusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const findingsText = (n: number): string => `${plural(n, 'finding needs', 'findings need')} your attention`;
const unheardText = (n: number): string => plural(n, 'unheard message', 'unheard messages');
const questionsText = (n: number): string => `${plural(n, 'question is', 'questions are')} waiting for your answer`;

/**
 * What a screen reader hears after the header Replay button's name. That button replays only the newest
 * message, so its marker is about that one message and always reads "Unheard message" (singular), however
 * many older messages are still unheard; the count belongs to the bubble.
 */
function replayDescriptionText(newestUnheard: boolean, unavailable: string | null): string {
  return [newestUnheard ? 'Unheard message' : null, unavailable].filter(Boolean).join('. ');
}

/** Rough height of the bubble's card at its fullest (two rows and the hint); decides whether it fits above the bubble. */
export const BUBBLE_CARD_HEIGHT = 100;
export const BUBBLE_CARD_WIDTH = 206;
export const BUBBLE_CARD_GAP = 10;

/**
 * Where the bubble's card goes: above the bubble with its right edge on the bubble's right edge, unless that
 * would leave the screen, in which case it drops below the bubble and/or lines up with the bubble's left edge.
 */
function bubbleCardPlacement(
  bubble: { x: number; y: number },
  viewport: { width: number; height: number },
): { above: boolean; alignLeft: boolean } {
  return {
    above: bubble.y - BUBBLE_CARD_GAP - BUBBLE_CARD_HEIGHT >= AVATAR_PANEL_MARGIN,
    alignLeft: bubble.x + AVATAR_BUBBLE_SIZE - BUBBLE_CARD_WIDTH < AVATAR_PANEL_MARGIN,
  };
}

export function AvatarDock({ attentionCount, onAnswerAsk }: AvatarDockProps) {
  const prefs = useAvatarPanelPrefs();
  const [viewport, setViewport] = useState(viewportSize);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [state, setState] = useState<AvatarState>('idle');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [still, setStill] = useState<string | null>(null);
  const [replayPending, setReplayPending] = useState(false);
  const [replayNotice, setReplayNotice] = useState<string | null>(null);
  // Why a press on the unavailable Replay button did nothing; cleared as soon as that reason changes or goes away.
  const [unavailableNotice, setUnavailableNotice] = useState<string | null>(null);
  // Bumped on every press of the unavailable button so the live region speaks the same text again.
  const [unavailableNoticeSeq, setUnavailableNoticeSeq] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Escape closes the card; it stays closed until the pointer or focus arrives again.
  const [cardDismissed, setCardDismissed] = useState(false);
  const lastClip = useLastClip();
  const clips = useClipHistory();
  const sound = useSoundPreference();
  const live = useLucyLive();
  const operatorAsks = useOperatorAsks();
  // Why a press on the unavailable Talk button did nothing, for people who cannot see its tooltip.
  const [talkNotice, setTalkNotice] = useState<string | null>(null);
  // Bumped on every press of the unavailable Talk button so the announcement is spoken again.
  const [talkNoticeSeq, setTalkNoticeSeq] = useState(0);
  // The operator's latest FINAL transcript, as a new entry each time one becomes final, so a screen
  // reader announces it once. Drafts change under the reader and are not announced. Lucy's own words are
  // never announced: she is already speaking them, and a second voice would overlap hers and reach the open microphone.
  const [heardFinal, setHeardFinal] = useState<{ seq: number; text: string } | null>(null);

  const viewRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<AvatarStage | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const stateRef = useRef<AvatarState>('idle');
  const dragRef = useRef<{ pointerId: number; dx: number; dy: number; last: { x: number; y: number } | null } | null>(null);
  const minimiseButtonRef = useRef<HTMLButtonElement | null>(null);
  const talkFocusedRef = useRef(false);
  const dockRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLButtonElement | null>(null);
  // Set when the operator minimises or reopens, so keyboard focus can follow to the control that replaced the one they used.
  const restoreFocusRef = useRef(false);

  // Keep the panel on screen when the browser window is resized.
  useEffect(() => {
    const onResize = (): void => setViewport(viewportSize());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const panelSize = { width: AVATAR_PANEL_WIDTH, height: AVATAR_PANEL_HEIGHT };
  const position = clampAvatarPanelPosition(
    dragPos ?? prefs.position ?? defaultAvatarPanelPosition(viewport, panelSize),
    viewport,
    panelSize,
  );
  // The bubble sits where the panel's bottom-right corner is, so minimising does not make it jump away.
  const bubblePosition = clampAvatarPanelPosition(
    { x: position.x + AVATAR_PANEL_WIDTH - AVATAR_BUBBLE_SIZE, y: position.y + AVATAR_PANEL_HEIGHT - AVATAR_BUBBLE_SIZE },
    viewport,
    { width: AVATAR_BUBBLE_SIZE, height: AVATAR_BUBBLE_SIZE },
  );

  // Follow Kookr's speech playback.
  useEffect(() => {
    return subscribeSpeechBus((event) => {
      if (event.type === 'generating') {
        stateRef.current = 'thinking';
        analyserRef.current = null;
        setReplayNotice(null);
      } else if (event.type === 'playing') {
        stateRef.current = 'speaking';
        setReplayNotice(null);
        analyserRef.current = event.analyser;
      } else {
        stateRef.current = 'idle';
        analyserRef.current = null;
      }
      setState(stateRef.current);
      stageRef.current?.setState(stateRef.current);
      stageRef.current?.setAnalyser(analyserRef.current);
    });
  }, []);

  // Keep the "N min ago" labels current while the list is on screen: one timer, gone when the panel
  // is minimised, closed or the list is empty.
  const [now, setNow] = useState(() => Date.now());
  // Questions are kept current while minimised too: the bubble's badge counts the ones still waiting.
  const listVisible = (!prefs.minimized && clips.length > 0) || operatorAsks.asks.length > 0;
  useEffect(() => {
    if (!listVisible) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), RELATIVE_TIME_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [listVisible]);

  // A task just asked a question: Lucy says it, once. Only while this panel exists, so with the avatar
  // panel switched off nothing is spoken (the question is still on Telegram). If it is answered,
  // withdrawn or expires while she is reading it out, she stops.
  useEffect(() => {
    const offAnnounced = onAskAnnounced((ask) => { void announceAsk(ask.id); });
    const offClosed = onAskClosed((ask) => stopAskAnnouncement(ask.id));
    return () => {
      offAnnounced();
      offClosed();
    };
  }, []);

  const asks = visibleOperatorAsks(operatorAsks.asks, now);
  const pendingAskCount = asks.reduce((n, ask) => (ask.state === 'pending' ? n + 1 : n), 0);
  const onAnswer = useCallback((askId: string, choice: AskAnswerChoice) => {
    markAskSubmitting(askId, onAnswerAsk ? onAnswerAsk(askId, choice) : false);
  }, [onAnswerAsk]);

  // A replay must not keep talking after the panel is gone.
  useEffect(() => () => stopReplay('user_stop'), []);

  // The 3D view exists only while the panel is open.
  useLayoutEffect(() => {
    if (prefs.minimized) return undefined;
    const container = viewRef.current;
    if (!container) return undefined;
    setLoaded(false);
    setError(null);
    const stage = new AvatarStage({
      container,
      modelUrl: avatarUrl,
      onReady: () => setLoaded(true),
      onError: (reason) => setError(reason),
    });
    stage.setState(stateRef.current);
    stage.setAnalyser(analyserRef.current);
    stageRef.current = stage;
    return () => {
      const image = stage.snapshot();
      if (image) setStill(image);
      stage.dispose();
      if (stageRef.current === stage) stageRef.current = null;
    };
  }, [prefs.minimized]);

  const minimise = useCallback(() => {
    const image = stageRef.current?.snapshot();
    if (image) setStill(image);
    restoreFocusRef.current = true;
    trackPanelAction('minimize');
    updateAvatarPanelPrefs({ minimized: true });
  }, []);
  const open = useCallback(() => {
    restoreFocusRef.current = true;
    trackPanelAction('restore');
    updateAvatarPanelPrefs({ minimized: false });
  }, []);

  // The bubble that was hovered or focused is unmounted when the panel opens, so it never reports the pointer
  // leaving; forget those flags on every switch. Declared before the focus hand-over below, which may focus the bubble.
  useEffect(() => {
    setHovered(false);
    setFocused(false);
    setCardDismissed(false);
  }, [prefs.minimized]);

  // Minimising swaps the window for the bubble (and back), which unmounts the button that had focus.
  // Move focus to its counterpart so a keyboard user is not sent back to the top of the page.
  useEffect(() => {
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    (prefs.minimized ? bubbleRef.current : minimiseButtonRef.current)?.focus();
  }, [prefs.minimized]);

  // A way to move the window without dragging: each press sends it to the next corner of the viewport.
  const moveToNextCorner = useCallback(() => {
    const view = viewportSize();
    const right = view.width - AVATAR_PANEL_WIDTH - AVATAR_PANEL_MARGIN;
    const bottom = view.height - AVATAR_PANEL_HEIGHT - AVATAR_PANEL_MARGIN;
    const corners = [
      { x: right, y: bottom },
      { x: AVATAR_PANEL_MARGIN, y: bottom },
      { x: AVATAR_PANEL_MARGIN, y: AVATAR_PANEL_MARGIN },
      { x: right, y: AVATAR_PANEL_MARGIN },
    ].map((corner) => clampAvatarPanelPosition(corner, view));
    const here = clampAvatarPanelPosition(
      prefs.position ?? defaultAvatarPanelPosition(view),
      view,
    );
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    corners.forEach((corner, index) => {
      const distance = Math.hypot(corner.x - here.x, corner.y - here.y);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    trackPanelAction('move');
    updateAvatarPanelPrefs({ position: corners[(nearest + 1) % corners.length] });
  }, [prefs.position]);

  const onDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest('button')) return;
      dragRef.current = { pointerId: event.pointerId, dx: event.clientX - position.x, dy: event.clientY - position.y, last: null };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [position.x, position.y],
  );
  const onDragMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.last = clampAvatarPanelPosition(
        { x: event.clientX - drag.dx, y: event.clientY - drag.dy },
        viewportSize(),
      );
      setDragPos(drag.last);
    },
    [],
  );
  const onDragEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    // Save where it was dropped. A press and release without movement is not a move.
    if (drag.last) {
      trackPanelAction('move');
      updateAvatarPanelPrefs({ position: drag.last });
    }
    setDragPos(null);
  }, []);

  // Hands-free is on and connected: the label and hint follow what the server says Lucy is doing.
  const liveReady = live.status === 'ready';
  // The Talk button is shown when it works, and when we can say why it does not (sound off, or the server's reason).
  // If the server could not be asked, or said "no" without a reason, there is nothing useful to say, so it stays hidden.
  const serverReason = live.serverStatus && !live.serverStatus.available ? (live.serverStatus.reason ?? null) : null;
  const talkUnavailable = live.enabled ? null : !sound.enabled ? SOUND_OFF_REASON : serverReason;
  const talkVisible = live.enabled || live.status !== 'off' || live.serverStatus?.available === true || serverReason !== null;
  useEffect(() => {
    setTalkNotice(null);
  }, [talkUnavailable]);
  const onTalk = (): void => {
    if (talkUnavailable) {
      setTalkNotice(talkUnavailable);
      setTalkNoticeSeq((n) => n + 1);
      return;
    }
    setTalkNotice(null);
    live.setEnabled(!live.enabled);
  };
  const liveMessage = talkNotice ?? live.errorMessage;
  useEffect(() => {
    if (!live.enabled) setHeardFinal(null);
    else if (live.operatorFinal && live.operatorText) setHeardFinal((previous) => ({ seq: (previous?.seq ?? 0) + 1, text: live.operatorText }));
  }, [live.enabled, live.operatorFinal, live.operatorText]);
  // If the Talk button disappears while it has focus, keyboard focus would fall to the page; keep it in the dock.
  useLayoutEffect(() => {
    if (!talkVisible && talkFocusedRef.current) {
      talkFocusedRef.current = false;
      dockRef.current?.focus();
    }
  }, [talkVisible]);
  const liveStateLabel = liveReady ? LIVE_STATE_LABEL[live.lucyState] : live.status === 'connecting' ? 'connecting' : null;
  const showLive = live.enabled || liveMessage !== null;
  // Spoken by the always-present announcement region below (a live region must exist before its text does).
  const connectingNotice = live.status === 'connecting' ? 'Connecting\u2026' : null;
  const announcement = liveMessage ?? connectingNotice;

  // Replay is unavailable (not hidden) when there is nothing to play, she is busy, or sound is off in Settings.
  const replayUnavailable = !lastClip.hasClip
    ? 'No message to replay yet'
    : state !== 'idle' || replayPending
      ? `${NAME} is busy; replay is available when she has finished`
      : !sound.enabled
        ? REPLAY_MUTED_TITLE
        : null;
  useEffect(() => {
    setUnavailableNotice(null);
  }, [replayUnavailable]);
  // `clipId` is set by a message's own Replay button; the header button replays the newest message.
  const onReplay = (clipId?: string): void => {
    if (replayUnavailable) {
      // The button stays focusable and `title` does not reach keyboard or touch users, so say it in the live region.
      // The longer muted wording only when sound-off is the real reason; "nothing to replay" and "busy" are not.
      setUnavailableNotice(replayUnavailable === REPLAY_MUTED_TITLE ? (REPLAY_NOTICE.muted ?? replayUnavailable) : replayUnavailable);
      setUnavailableNoticeSeq((n) => n + 1);
      return;
    }
    trackPanelAction('replay', clipId);
    setReplayNotice(null);
    setReplayPending(true);
    void (clipId ? replayClip(clipId) : replayLastClip()).then((result) => {
      setReplayPending(false);
      setReplayNotice(REPLAY_NOTICE[result] ?? null);
    });
  };

  // Read by assistive technology when the Replay button gets focus: the unheard marker (a dot) and why it is unavailable.
  const statusNotice = replayNotice ?? unavailableNotice;
  const newestUnheard = clips[0]?.heard === false;
  const replayDescription = replayDescriptionText(newestUnheard, replayUnavailable);

  // The bubble's card: what the badge and the dot mean. It only repeats what the bubble's label says, so it is
  // hidden from assistive technology; keyboard users get it through focus, Escape closes it.
  const cardHasContent = attentionCount > 0 || lastClip.unheardCount > 0 || pendingAskCount > 0;
  const cardVisible = prefs.minimized && cardHasContent && (hovered || focused) && !cardDismissed;
  useEffect(() => {
    if (!cardVisible) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setCardDismissed(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cardVisible]);

  const onBubbleEnter = (): void => {
    setHovered(true);
    setCardDismissed(false);
  };
  const onBubbleLeave = (): void => setHovered(false);
  const onBubbleFocus = (event: ReactFocusEvent<HTMLButtonElement>): void => {
    // Only keyboard focus: a mouse press that moved focus here (or the hand-over after a mouse
    // minimise) must not open the card by itself.
    if (!matchesFocusVisible(event.currentTarget)) return;
    setFocused(true);
    setCardDismissed(false);
  };
  const onBubbleBlur = (): void => setFocused(false);

  if (prefs.minimized) {
    const activity = state !== 'idle' ? `, ${STATE_LABEL[state]}` : liveReady ? ', listening' : '';
    const label = [
      `Open ${NAME}${activity}`,
      pendingAskCount > 0 ? questionsText(pendingAskCount) : null,
      attentionCount > 0 ? findingsText(attentionCount) : null,
      lastClip.unheardCount > 0 ? unheardText(lastClip.unheardCount) : null,
    ]
      .filter(Boolean)
      .join('. ') + (cardHasContent ? '.' : '');
    // One number on the bubble: everything that is waiting for the operator.
    const badgeCount = attentionCount + pendingAskCount;
    const cardPlacement = bubbleCardPlacement(bubblePosition, viewport);
    const cardRight = bubblePosition.x + AVATAR_BUBBLE_SIZE;
    return (
      <>
        <button
          type="button"
          ref={bubbleRef}
          className={`avatar-bubble avatar-bubble-${state}${live.enabled ? ' avatar-bubble-live' : ''}`}
          style={{ left: bubblePosition.x, top: bubblePosition.y, backgroundImage: still ? `url(${still})` : undefined }}
          onClick={open}
          onMouseEnter={onBubbleEnter}
          onMouseLeave={onBubbleLeave}
          onFocus={onBubbleFocus}
          onBlur={onBubbleBlur}
          aria-label={label}
          // The card says the same on hover, so the browser's own tooltip would only get in its way.
          title={cardVisible ? undefined : label}
          data-testid="avatar-bubble"
        >
          {!still && <span className="avatar-bubble-initial" aria-hidden="true">{NAME[0]}</span>}
          {live.enabled && <span className="avatar-bubble-mic" data-testid="avatar-bubble-mic" aria-hidden="true" />}
          {lastClip.unheard && <span className="avatar-unheard-dot avatar-bubble-unheard" data-testid="avatar-unheard-dot" aria-hidden="true" />}
          {badgeCount > 0 && (
            <span className="avatar-bubble-badge" aria-hidden="true">{badgeCount > 99 ? '99+' : badgeCount}</span>
          )}
        </button>
        {cardVisible && (
          <div
            className="avatar-bubble-card"
            style={{
              ...(cardPlacement.above
                ? { bottom: viewport.height - bubblePosition.y + BUBBLE_CARD_GAP }
                : { top: bubblePosition.y + AVATAR_BUBBLE_SIZE + BUBBLE_CARD_GAP }),
              ...(cardPlacement.alignLeft
                ? { left: bubblePosition.x }
                : { right: viewport.width - cardRight }),
              width: BUBBLE_CARD_WIDTH,
            }}
            aria-hidden="true"
            data-testid="avatar-bubble-card"
          >
            {pendingAskCount > 0 && (
              <div className="avatar-bubble-card-row" data-testid="avatar-bubble-card-asks">
                <span className="avatar-mark-diamond" />
                {plural(pendingAskCount, 'question', 'questions')} for you
              </div>
            )}
            {attentionCount > 0 && (
              <div className="avatar-bubble-card-row">
                <span className="avatar-mark-diamond" />
                {plural(attentionCount, 'finding needs', 'findings need')} you
              </div>
            )}
            {lastClip.unheardCount > 0 && (
              <div className="avatar-bubble-card-row">
                <span className="avatar-mark-dot" />
                {unheardText(lastClip.unheardCount)}
              </div>
            )}
            <div className="avatar-bubble-card-hint">Click to open {NAME}</div>
          </div>
        )}
      </>
    );
  }

  const replayTitleSuffix = newestUnheard ? ' (unheard)' : '';
  const newestId = clips[0]?.clipId;
  return (
    <section
      className={`avatar-dock avatar-dock-${state}${liveReady ? ' avatar-dock-live' : ''}${asks.length > 0 ? ' avatar-dock-asking' : ''}${pendingAskCount > 0 ? ' avatar-dock-ask-waiting' : ''}${dragPos ? ' avatar-dock-dragging' : ''}`}
      style={{ left: position.x, top: position.y, width: AVATAR_PANEL_WIDTH, height: AVATAR_PANEL_HEIGHT }}
      aria-label={`${NAME} avatar`}
      ref={dockRef}
      tabIndex={-1}
      data-testid="avatar-dock"
      data-avatar-state={state}
      data-lucy-live={live.status}
      data-avatar-loaded={loaded ? 'true' : 'false'}
    >
      <div
        className="avatar-dock-header"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <span className="avatar-dock-name">{NAME.toUpperCase()}</span>
        <span className="avatar-dock-state" data-testid="avatar-state-label">{liveStateLabel ?? STATE_LABEL[state]}</span>
        <span className="avatar-dock-spacer" />
        {talkVisible && (
          <button
            type="button"
            className={`avatar-dock-button avatar-dock-talk${live.enabled ? ' avatar-dock-talk-on' : ''}`}
            onClick={onTalk}
            aria-pressed={live.enabled}
            // aria-disabled, like Replay: it stays focusable so the reason can be read and pressing it can say why.
            aria-disabled={talkUnavailable ? 'true' : undefined}
            aria-label={TALK_LABEL}
            onFocus={() => { talkFocusedRef.current = true; }}
            onBlur={() => { talkFocusedRef.current = false; }}
            aria-describedby={talkUnavailable ? TALK_REASON_ID : undefined}
            title={talkUnavailable ?? (live.enabled ? TALK_STOP_LABEL : TALK_LABEL)}
            data-testid="avatar-talk"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="6" y="1.5" width="4" height="8" rx="2" />
              <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5" />
            </svg>
            {talkUnavailable && <span id={TALK_REASON_ID} className="sr-only">{talkUnavailable}</span>}
          </button>
        )}
        <button
          type="button"
          className="avatar-dock-button avatar-dock-replay"
          onClick={() => onReplay()}
          // aria-disabled rather than disabled: a disabled button drops keyboard focus, and focus must stay
          // here after Replay is pressed (she is then busy until the clip ends).
          aria-disabled={replayUnavailable ? 'true' : undefined}
          aria-label={REPLAY_LABEL}
          aria-describedby={replayDescription ? REPLAY_DESCRIPTION_ID : undefined}
          title={replayUnavailable ?? `${REPLAY_LABEL}${replayTitleSuffix}`}
          data-testid="avatar-replay"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" /><path d="M7 6v4l3-2z" /></svg>
          {newestUnheard && (
            <span className="avatar-unheard-dot avatar-dock-unheard" data-testid="avatar-unheard-dot" aria-hidden="true" />
          )}
          {replayDescription && <span id={REPLAY_DESCRIPTION_ID} className="sr-only">{replayDescription}</span>}
        </button>
        <button type="button" className="avatar-dock-button" onClick={moveToNextCorner} aria-label={`Move ${NAME} to the next corner`} title="Move to the next corner">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v12M2 8h12M6 4l2-2 2 2M6 12l2 2 2-2M4 6L2 8l2 2M12 6l2 2-2 2" /></svg>
        </button>
        <button type="button" ref={minimiseButtonRef} className="avatar-dock-button" onClick={minimise} aria-label={`Minimise ${NAME}`} title="Minimise">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg>
        </button>
      </div>
      <div className="avatar-dock-view" ref={viewRef}>
        {/* Always present and never hidden, only emptied: screen readers announce text added to a live
            region reliably only if the region was already there. */}
        <span className="avatar-dock-status" role="status">
          {error
            ? `The 3D view could not start (${error}). Spoken summaries still play.`
            : statusNotice
              ? <span key={replayNotice ? 'replay' : `unavailable-${unavailableNoticeSeq}`}>{statusNotice}</span>
              : loaded
                ? ''
                : 'Loading…'}
        </span>
      </div>
      {/* Always present, only emptied: the Talk-unavailable reason, errors, "Connecting\u2026" and the operator's
          final words are announced from here. Each change is a new element so it is spoken again. */}
      <div className="sr-only" role="status" data-testid="avatar-live-announce">
        {announcement && <span key={`notice-${talkNoticeSeq}-${announcement}`}>{announcement}</span>}
        {heardFinal && <span key={`heard-${heardFinal.seq}`}>You said: {heardFinal.text}</span>}
      </div>
      {asks.length > 0 && (
        // Questions from tasks (`kookr ask`), above everything else she shows: a task is waiting on these.
        <ol
          className="avatar-asks"
          aria-label={pendingAskCount > 0 ? `Questions waiting for your answer (${pendingAskCount})` : 'Recent questions'}
          data-testid="avatar-asks"
        >
          {asks.map((ask) => (
            <AskCard
              key={ask.id}
              ask={ask}
              submit={operatorAsks.submit[ask.id]}
              nowMs={now}
              onAnswer={onAnswer}
              onDismiss={dismissOperatorAsk}
            />
          ))}
        </ol>
      )}
      {showLive && (
        // A log, but not a live one: Lucy's answer is spoken aloud already, so it is not announced.
        // Focusable because it scrolls.
        <div
          className="avatar-live"
          role="log"
          aria-live="off"
          aria-label={`Conversation with ${NAME}`}
          tabIndex={0}
          data-testid="avatar-live"
        >
          {liveMessage && <p className="avatar-live-notice" data-testid="avatar-live-notice">{liveMessage}</p>}
          {connectingNotice && <p className="avatar-live-notice">{connectingNotice}</p>}
          {live.operatorText && (
            <p
              className={`avatar-live-you${live.operatorFinal ? '' : ' avatar-live-draft'}`}
              data-testid="avatar-live-you"
              data-final={live.operatorFinal ? 'true' : 'false'}
            >
              <span className="avatar-live-who">You</span> {live.operatorText}
            </p>
          )}
          {live.lucyText && (
            <p className="avatar-live-lucy" data-testid="avatar-live-lucy">
              <span className="avatar-live-who">{NAME}</span> {live.lucyText}
            </p>
          )}
        </div>
      )}
      {/* With messages, the list is a scroll region of its own that the keyboard can reach: the full text of a
          long message is in the layout, so scrolling is the only way to the rest of it. */}
      <div
        className="avatar-dock-transcript"
        data-testid="avatar-transcript"
        {...(clips.length > 0 ? { role: 'region', 'aria-label': 'Recent messages', tabIndex: 0 } : {})}
      >
        {clips.length === 0 ? (
          <p className="avatar-dock-hint" data-testid="avatar-hint">{liveReady ? LIVE_HINT : IDLE_HINT}</p>
        ) : (
          <>
            {replayUnavailable && <span id={REPLAY_REASON_ID} className="sr-only">{replayUnavailable}</span>}
            <ol className="avatar-msg-list" data-testid="avatar-messages">
              {clips.map((clip) => {
                const time = formatRelativeTime(clip.at, now);
                const newest = clip.clipId === newestId;
                const replayName = clip.subject ? `Replay message about ${clip.subject}, ${time}` : `Replay message, ${time}`;
                return (
                  <li
                    key={clip.clipId}
                    className={`avatar-msg${newest ? ' avatar-msg-newest' : ''}`}
                    data-testid="avatar-message"
                    data-clip-id={clip.clipId}
                  >
                    <p className="avatar-msg-text">{clip.text}</p>
                    <div className="avatar-msg-meta">
                      {clip.subject && (
                        <>
                          <span className="avatar-msg-subject">{clip.subject}</span>
                          <span className="avatar-msg-sep" aria-hidden="true">·</span>
                        </>
                      )}
                      <span className="avatar-msg-time">{time}</span>
                      {!clip.heard && (
                        <span className="avatar-msg-unheard" data-testid="avatar-msg-unheard">
                          <span className="avatar-mark-dot" aria-hidden="true" />
                          unheard
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="avatar-dock-button avatar-msg-replay"
                      onClick={() => onReplay(clip.clipId)}
                      // Same pattern as the header button: aria-disabled keeps it focusable, so focus stays here after a press.
                      aria-disabled={replayUnavailable ? 'true' : undefined}
                      aria-label={replayName}
                      aria-describedby={replayUnavailable ? REPLAY_REASON_ID : undefined}
                      title={replayUnavailable ?? replayName}
                      data-testid="avatar-msg-replay"
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" /><path d="M7 6v4l3-2z" /></svg>
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}
