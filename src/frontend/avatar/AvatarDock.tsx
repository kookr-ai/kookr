/**
 * The optional avatar panel: Lucy's column, docked to the right edge of the dashboard. The dashboard
 * shrinks to make room for it instead of being covered. It shows a 3D character who lip-syncs what
 * Kookr says aloud: the spoken summaries played by the speaker buttons on tasks, and the questions
 * tasks ask the operator (described below).
 *
 * The column is as tall as the window and 380 px wide by default; its left edge can be dragged
 * (`ColumnResizer.tsx`, 320 to 560 px) and the width is remembered. The page keeps at least 1000 px: in a
 * window too narrow for that (769 to 1319 px) the column floats over the page instead of taking room from
 * it, and a wide saved width is capped so the page keeps its 1000 px (the cap is not saved). On a window of
 * 768 px and below it is a full-width sheet over the page (`avatarColumnLayout` decides). It minimises to a round bubble in the bottom-right
 * corner, which brings the page back to full width. While minimised the 3D view is shut down completely,
 * and the bubble shows a still image, so a minimised panel uses no GPU. Hovering or focusing the bubble
 * shows a small card that spells out what its badge and dot mean.
 *
 * From top to bottom the column holds:
 *  - the header: her name, what she is doing, Talk, Replay last, Minimise;
 *  - the 3D view, always 120 px tall;
 *  - the tray "Waiting on you" (`WaitingTray.tsx`): permission cards, the questions tasks ask the operator
 *    (`kookr ask`, the same question that goes to Telegram; Lucy reads one out once when it arrives), and a
 *    folded row for opinion requests from tasks that have already ended. Answering there closes the
 *    question on Telegram too, and an answer given on Telegram turns the card into "Answered on Telegram";
 *  - the conversation thread (`LucyThread.tsx`): what the operator typed, the Talk exchanges and every
 *    message she said aloud, oldest first;
 *  - the launch card, when she proposes starting a task (`LucyLaunchCard.tsx`), always whole above the box;
 *  - the action card, when she proposes answering, replying to or closing a task (`LucyActionCard.tsx`), in the same place;
 *  - the composer: the text box for typing to her (`LucyTypedInput.tsx`).
 *
 * A "Talk" button in the header switches on hands-free conversation with Lucy
 * (`lucy-live/useLucyLive.ts`): she listens through the microphone, answers out loud
 * and can be interrupted by speaking over her. It lives in this component, not in the
 * 3D view, so it keeps running while the panel is minimised, and it is never saved:
 * every page load starts with the microphone closed. A keyboard shortcut (Alt+Shift+M by
 * default, `lucy_talk_toggle`) does the same from anywhere, and while Talk is on the
 * minimised bubble carries a small microphone button that switches it off in one click.
 *
 * While minimised, the bubble's badge counts the waiting questions and findings. What she says and what is
 * typed is still recorded into the thread (`useThreadSync.ts`), so it is there when the panel is opened.
 *
 * When a task has waited on a permission prompt for a minute, the server sends a card with the
 * command and Approve once / Deny (`LucyPermissionCard.tsx`), and Lucy says one sentence about it
 * (issue #3932). The sentence is spoken from here, so with the panel off nothing is said.
 *
 * This file and everything it imports (three.js, the avatar file) is loaded
 * only when the operator has switched the panel on — see the lazy import in
 * App.tsx and `store/avatar-panel-prefs.ts`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent } from 'react';
import avatarUrl from './assets/lucy-bust.glb?url';
import { AvatarStage, type AvatarState } from './avatar-stage.js';
import { subscribeSpeechBus } from '../audio/speech-bus.js';
import { getLastClip, useClipHistory, useLastClip } from '../audio/last-clip.js';
import { replayClip, replayLastClip, stopReplay, type ReplayResult } from '../audio/clip-playback.js';
import { useSoundPreference } from '../audio/sound-preference.js';
import { track } from '../telemetry.js';
import {
  announceAsk,
  announcePermissionNotice,
  stopAllAskAnnouncements,
  stopAskAnnouncement,
  stopPermissionNotice,
} from '../audio/ask-announcement.js';
import { onPermissionAnnounced, onPermissionNoticeWithdrawn } from '../store/lucy-permission.js';
import type { PermissionChoiceSender } from './LucyPermissionCard.js';
import {
  askClockOffsetMs,
  onAskAnnounced,
  onAskClosed,
  useOperatorAsks,
  visibleOperatorAsks,
} from '../store/operator-asks.js';
import { askOutcome, type AskAnswerChoice } from './AskCard.js';
import { openAskLink } from './ask-links.js';
import { LucyLaunchCard } from './LucyLaunchCard.js';
import { LucyActionCard } from './LucyActionCard.js';
import { LucyTypedInput } from './LucyTypedInput.js';
import { LucyThread } from './LucyThread.js';
import { WaitingTray } from './WaitingTray.js';
import { ColumnResizer } from './ColumnResizer.js';
import { useClipThreadSync, useNoticeThreadSync, useTalkThreadSync } from './useThreadSync.js';
import { useLucyConversation } from '../store/lucy-conversation.js';
import { SOUND_OFF_REASON, useLucyLive } from '../lucy-live/useLucyLive.js';
import type { LucyLiveState } from '../../shared/contracts/lucy-live.js';
import { formatShortcutBinding, matchesShortcutBinding, type ShortcutBinding } from '../../shared/contracts/shortcut-bindings.js';
import {
  avatarColumnLayout,
  clampAvatarColumnWidth,
  updateAvatarPanelPrefs,
  useAvatarPanelPrefs,
} from '../store/avatar-panel-prefs.js';

const NAME = 'Lucy';
const STATE_LABEL: Record<AvatarState, string> = {
  idle: 'ready',
  thinking: 'preparing',
  speaking: 'speaking',
};
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
/** Re-render the "N min ago" labels this often while the thread is on screen. */
const RELATIVE_TIME_REFRESH_MS = 30_000;

/** Shown in the status region when a replay could not start; the three other results need no message. */
const REPLAY_MUTED_TITLE = 'Sound is off in Settings';

const REPLAY_NOTICE: Partial<Record<ReplayResult, string>> = {
  muted: 'Sound is off in Settings, so the message was not replayed.',
  blocked: 'Your browser blocked audio. Press Replay again to allow it.',
  error: 'The message could not be played again.',
};

function trackPanelAction(action: 'minimize' | 'restore' | 'replay', replayedClipId?: string): void {
  const clipId = replayedClipId ?? getLastClip()?.clipId;
  track({ type: 'lucy_panel_action', action, ...(clipId ? { clipId } : {}) });
}

/** The name of the CSS custom property on the page's root element that tells the dashboard how much room the open column takes. */
export const COLUMN_WIDTH_PROPERTY = '--lucy-column-width';

export interface AvatarDockProps {
  /** How many tasks are waiting for the operator; shown as a badge on the bubble. */
  attentionCount: number;
  /**
   * Send the operator's answer to a `kookr ask` question over the dashboard socket.
   * Returns false when it could not be sent (not connected). Without it the cards are
   * still shown, and an answer reports "not connected".
   */
  onAnswerAsk?: (askId: string, choice: AskAnswerChoice) => boolean;
  /**
   * Select a task in the dashboard: the "Open task" button on a question card, and "show me the task"
   * by voice. Returns false when the task cannot be shown. Without it there is no "Open task" button.
   */
  onOpenTask?: (taskId: string) => boolean;
  /**
   * Send Approve once / Deny from a permission card (the dashboard's `permissionChoice` message).
   * Returns false when it could not be sent. Without it the cards show no buttons that work.
   */
  onPermissionChoice?: PermissionChoiceSender;
  /**
   * The key that switches Talk on or off from anywhere in the dashboard, text boxes included (it is not
   * dictation's key). Without it there is no shortcut.
   */
  talkShortcut?: ShortcutBinding;
  /** True while a dialog that swallows the dashboard's shortcuts is open: the Talk shortcut then does nothing. */
  shortcutsBlocked?: boolean;
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
const opinionsText = (n: number): string => `${plural(n, 'opinion', 'opinions')} wanted`;

/**
 * What a screen reader hears after the header Replay button's name. That button replays only the newest
 * message, so its marker is about that one message and always reads "Unheard message" (singular), however
 * many older messages are still unheard; the count belongs to the bubble.
 */
function replayDescriptionText(newestUnheard: boolean, unavailable: string | null): string {
  return [newestUnheard ? 'Unheard message' : null, unavailable].filter(Boolean).join('. ');
}

export function AvatarDock({
  attentionCount,
  onAnswerAsk,
  onOpenTask,
  onPermissionChoice,
  talkShortcut,
  shortcutsBlocked = false,
}: AvatarDockProps) {
  const prefs = useAvatarPanelPrefs();
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  // The width while the left edge is being dragged; saved only when the drag ends.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
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
  const entries = useLucyConversation();
  const sound = useSoundPreference();
  const live = useLucyLive({
    // "Show me the mockups" / "open the task" while a question is waiting (the server picks the target).
    onOpen: (target) => {
      if (target.kind === 'link') return openAskLink(target.url);
      return onOpenTask?.(target.taskId) ? 'opened' : 'unavailable';
    },
  });
  const operatorAsks = useOperatorAsks();
  // Why a press on the unavailable Talk button did nothing, for people who cannot see its tooltip.
  const [talkNotice, setTalkNotice] = useState<string | null>(null);
  // Bumped on every press of the unavailable Talk button so the announcement is spoken again.
  const [talkNoticeSeq, setTalkNoticeSeq] = useState(0);
  // The operator's latest FINAL transcript, as a new entry each time one becomes final, so a screen
  // reader announces it once. Drafts change under the reader and are not announced. Lucy's own words are
  // never announced: she is already speaking them, and a second voice would overlap hers and reach the open microphone.
  const [heardFinal, setHeardFinal] = useState<{ seq: number; text: string } | null>(null);
  // What a screen reader is told about questions from tasks: that one arrived (Lucy speaks the question
  // itself, so only a short notice) and how one ended (which she does not say). A new entry per event.
  const [askNotice, setAskNotice] = useState<{ seq: number; text: string } | null>(null);

  const viewRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<AvatarStage | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const stateRef = useRef<AvatarState>('idle');
  const minimiseButtonRef = useRef<HTMLButtonElement | null>(null);
  const talkFocusedRef = useRef(false);
  const bubbleStopFocusedRef = useRef(false);
  const dockRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLButtonElement | null>(null);
  // Set when the operator minimises or reopens, so keyboard focus can follow to the control that replaced the one they used.
  const restoreFocusRef = useRef(false);

  // A narrow window gets the full-width sheet, a wider one the column beside the page.
  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // Where it sits for this window: beside the page, floating over it, or a full-width sheet (see `avatarColumnLayout`).
  const layout = avatarColumnLayout(viewportWidth, prefs.width);
  const sheet = layout.mode === 'sheet';
  const docked = layout.mode === 'docked';
  const columnWidth = dragWidth === null ? layout.width : clampAvatarColumnWidth(dragWidth, layout.maxWidth);

  // While the column is docked beside the page, tell the page how much room it takes: the dashboard and the
  // overlays at the right edge stop short of it (`--lucy-column-width` in styles.css). Gone again when the
  // column is minimised, floats over the page or is a sheet, switched off or unmounted, so the page has its full width back.
  useLayoutEffect(() => {
    if (prefs.minimized || !docked) return undefined;
    const root = document.documentElement;
    root.style.setProperty(COLUMN_WIDTH_PROPERTY, `${columnWidth}px`);
    return () => {
      root.style.removeProperty(COLUMN_WIDTH_PROPERTY);
    };
  }, [prefs.minimized, docked, columnWidth]);

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

  // Keep the "N min ago" labels current while the thread is on screen: one timer, gone when the panel
  // is minimised, closed or there is nothing to date.
  const [now, setNow] = useState(() => Date.now());
  const threadHasClips = entries.some((entry) => entry.kind === 'clip');
  // Questions are kept current while minimised too: the bubble's badge counts the ones still waiting.
  const listVisible = (!prefs.minimized && (clips.length > 0 || threadHasClips)) || operatorAsks.asks.length > 0;
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
    const notice = (text: string): void => setAskNotice((previous) => ({ seq: (previous?.seq ?? 0) + 1, text }));
    const offAnnounced = onAskAnnounced((ask) => {
      notice(ask.taskName ? `New question from ${ask.taskName}.` : 'New question from a task.');
      void announceAsk(ask.id);
    });
    const offClosed = onAskClosed((ask) => {
      notice(`${askOutcome(ask).text}. Question: ${ask.question}`);
      stopAskAnnouncement(ask.id);
    });
    // A task has waited on a permission prompt (issue #3932): the same rules, and she stops once every
    // prompt the sentence is about has been answered.
    const offPermission = onPermissionAnnounced((announcement) => {
      notice(announcement.promptIds.length === 1 ? 'A task is waiting for your permission.' : 'Tasks are waiting for your permission.');
      void announcePermissionNotice(announcement.noticeId);
    });
    const offWithdrawn = onPermissionNoticeWithdrawn((noticeId) => stopPermissionNotice(noticeId));
    return () => {
      offAnnounced();
      offClosed();
      offPermission();
      offWithdrawn();
      // The panel is going away (switched off): a clip still being fetched must not be played afterwards.
      stopAllAskAnnouncements();
    };
  }, []);

  const asks = visibleOperatorAsks(operatorAsks.asks, now + askClockOffsetMs());
  // Questions a task may still be waiting for, and opinion requests from tasks that have ended (they block nothing,
  // so they are not "questions for you" and add nothing to the badge).
  const pendingAskCount = asks.reduce((n, ask) => (ask.state === 'pending' && ask.taskEnded !== true ? n + 1 : n), 0);
  const opinionCount = asks.reduce((n, ask) => (ask.state === 'pending' && ask.taskEnded === true ? n + 1 : n), 0);

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

  // Minimising swaps the column for the bubble (and back), which unmounts the button that had focus.
  // Move focus to its counterpart so a keyboard user is not sent back to the top of the page.
  useEffect(() => {
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    (prefs.minimized ? bubbleRef.current : minimiseButtonRef.current)?.focus();
  }, [prefs.minimized]);

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
  const talkShortcutHint = talkShortcut ? ` (${formatShortcutBinding(talkShortcut)})` : '';
  // The keyboard shortcut presses the Talk button, also while it is not on screen (panel minimised).
  // Kept in a ref so the key listener below is added once, not on every render.
  const talkShortcutRef = useRef<() => void>(() => {});
  talkShortcutRef.current = () => {
    // Hidden button: the server could not be asked, so there is nothing to switch on and no reason to give.
    if (!talkVisible) return;
    if (talkShortcut) track({ type: 'shortcut_used', key: formatShortcutBinding(talkShortcut), action: 'lucy_talk_toggle', context: 'global' });
    if (talkUnavailable && prefs.minimized) {
      // The reason is only shown in the open panel, so open it; focus moves only if it was on the bubble.
      restoreFocusRef.current = document.activeElement === bubbleRef.current;
      trackPanelAction('restore');
      updateAvatarPanelPrefs({ minimized: false });
    }
    onTalk();
  };
  useEffect(() => {
    if (!talkShortcut || shortcutsBlocked) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      // A held key repeats; it must not flip the microphone on and off.
      if (event.repeat || event.isComposing || !matchesShortcutBinding(event, talkShortcut)) return;
      event.preventDefault();
      talkShortcutRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [talkShortcut, shortcutsBlocked]);
  const liveMessage = talkNotice ?? live.errorMessage;
  useEffect(() => {
    if (!live.enabled) setHeardFinal(null);
    else if (live.operatorFinal && live.operatorText) setHeardFinal((previous) => ({ seq: (previous?.seq ?? 0) + 1, text: live.operatorText }));
  }, [live.enabled, live.operatorFinal, live.operatorText]);
  // Everything said is recorded into the thread from here, which stays mounted while the panel is minimised.
  useTalkThreadSync(live);
  useClipThreadSync(clips);
  useNoticeThreadSync(liveMessage, talkNoticeSeq);
  // If the Talk button disappears while it has focus, keyboard focus would fall to the page; keep it in the dock.
  useLayoutEffect(() => {
    if (!talkVisible && talkFocusedRef.current) {
      talkFocusedRef.current = false;
      dockRef.current?.focus();
    }
  }, [talkVisible]);
  // The bubble's stop button disappears once Talk is off; if it had focus, hand it to the bubble.
  useLayoutEffect(() => {
    if (!live.enabled && bubbleStopFocusedRef.current) {
      bubbleStopFocusedRef.current = false;
      bubbleRef.current?.focus();
    }
  }, [live.enabled]);
  const liveStateLabel = liveReady ? LIVE_STATE_LABEL[live.lucyState] : live.status === 'connecting' ? 'connecting' : null;
  // Spoken by the always-present announcement region below (a live region must exist before its text does).
  const connectingNotice = live.status === 'connecting' ? 'Connecting…' : null;
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
  const cardHasContent = attentionCount > 0 || lastClip.unheardCount > 0 || pendingAskCount > 0 || opinionCount > 0;
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
      opinionCount > 0 ? opinionsText(opinionCount) : null,
      attentionCount > 0 ? findingsText(attentionCount) : null,
      lastClip.unheardCount > 0 ? unheardText(lastClip.unheardCount) : null,
    ]
      .filter(Boolean)
      .join('. ') + (cardHasContent ? '.' : '');
    // One number on the bubble: everything that is waiting for the operator (opinion requests block nothing and are not in it).
    const badgeCount = attentionCount + pendingAskCount;
    return (
      <>
        {/* The bubble sits in the bottom-right corner (see `.avatar-bubble` in styles.css), not where a window was dragged. */}
        <button
          type="button"
          ref={bubbleRef}
          className={`avatar-bubble avatar-bubble-${state}${live.enabled ? ' avatar-bubble-live' : ''}`}
          style={{ backgroundImage: still ? `url(${still})` : undefined }}
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
          {lastClip.unheard && <span className="avatar-unheard-dot avatar-bubble-unheard" data-testid="avatar-unheard-dot" aria-hidden="true" />}
          {badgeCount > 0 && (
            <span className="avatar-bubble-badge" aria-hidden="true">{badgeCount > 99 ? '99+' : badgeCount}</span>
          )}
        </button>
        {live.enabled && (
          // A sibling of the bubble, not inside it: a button cannot hold another, and a press on the bubble opens the panel.
          // It replaces the bubble's "microphone open" dot and sits where that dot was.
          <button
            type="button"
            className="avatar-bubble-stop"
            onClick={onTalk}
            onFocus={() => { bubbleStopFocusedRef.current = true; }}
            onBlur={() => { bubbleStopFocusedRef.current = false; }}
            aria-label={TALK_STOP_LABEL}
            title={`${TALK_STOP_LABEL}${talkShortcutHint}`}
            data-testid="avatar-bubble-stop"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="6" y="1.5" width="4" height="8" rx="2" />
              <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5" />
              <path className="avatar-bubble-stop-slash" d="M2.5 2.5l11 11" />
            </svg>
          </button>
        )}
        {cardVisible && (
          <div className="avatar-bubble-card" aria-hidden="true" data-testid="avatar-bubble-card">
            {pendingAskCount > 0 && (
              <div className="avatar-bubble-card-row" data-testid="avatar-bubble-card-asks">
                <span className="avatar-mark-diamond" />
                {plural(pendingAskCount, 'question', 'questions')} for you
              </div>
            )}
            {opinionCount > 0 && (
              <div className="avatar-bubble-card-row" data-testid="avatar-bubble-card-opinions">
                <span className="avatar-mark-ring" />
                {opinionsText(opinionCount)}
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
  return (
    <section
      className={`avatar-dock avatar-dock-${state}${liveReady ? ' avatar-dock-live' : ''}${sheet ? ' avatar-dock-sheet' : ''}`}
      style={sheet ? undefined : { width: columnWidth }}
      aria-label={`${NAME} avatar`}
      ref={dockRef}
      tabIndex={-1}
      data-testid="avatar-dock"
      data-column-mode={layout.mode}
      data-avatar-state={state}
      data-lucy-live={live.status}
      data-avatar-loaded={loaded ? 'true' : 'false'}
    >
      {!sheet && (
        <ColumnResizer
          width={columnWidth}
          maxWidth={layout.maxWidth}
          onResize={setDragWidth}
          onCommit={(width) => {
            setDragWidth(null);
            updateAvatarPanelPrefs({ width });
          }}
        />
      )}
      <div className="avatar-dock-header">
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
            title={talkUnavailable ?? `${live.enabled ? TALK_STOP_LABEL : TALK_LABEL}${talkShortcutHint}`}
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
        <button type="button" ref={minimiseButtonRef} className="avatar-dock-button" onClick={minimise} aria-label={`Minimise ${NAME}`} title="Minimise">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
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
      {/* Always present, only emptied: the Talk-unavailable reason, errors, "Connecting…" and the operator's
          final words are announced from here. Each change is a new element so it is spoken again. */}
      <div className="sr-only" role="status" data-testid="avatar-live-announce">
        {announcement && <span key={`notice-${talkNoticeSeq}-${announcement}`}>{announcement}</span>}
        {heardFinal && <span key={`heard-${heardFinal.seq}`}>You said: {heardFinal.text}</span>}
        {askNotice && <span key={`ask-${askNotice.seq}`} data-testid="avatar-ask-announce">{askNotice.text}</span>}
      </div>
      <WaitingTray
        asks={asks}
        submit={operatorAsks.submit}
        nowMs={now + askClockOffsetMs()}
        dockRef={dockRef}
        {...(onAnswerAsk ? { onAnswerAsk } : {})}
        {...(onOpenTask ? { onOpenTask } : {})}
        {...(onPermissionChoice ? { onPermissionChoice } : {})}
      />
      <LucyThread
        entries={entries}
        clips={clips}
        nowMs={now}
        liveReady={liveReady}
        connecting={live.status === 'connecting'}
        replayUnavailable={replayUnavailable}
        replayReasonId={REPLAY_REASON_ID}
        onReplay={onReplay}
      />
      <LucyLaunchCard />
      <LucyActionCard />
      <LucyTypedInput />
    </section>
  );
}
