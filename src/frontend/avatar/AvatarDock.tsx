/**
 * The optional avatar panel: a small floating window, by default in the
 * bottom-right corner, showing a 3D character who lip-syncs Kookr's spoken
 * summaries (the clips played by the speaker buttons on tasks).
 *
 * It can be dragged by its title bar and minimised to a round bubble. While
 * minimised the 3D view is shut down completely, and the bubble shows a still
 * image, so a minimised panel uses no GPU.
 *
 * This file and everything it imports (three.js, the avatar file) is loaded
 * only when the operator has switched the panel on — see the lazy import in
 * App.tsx and `store/avatar-panel-prefs.ts`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import avatarUrl from './assets/lucy-bust.glb?url';
import { AvatarStage, type AvatarState } from './avatar-stage.js';
import { subscribeSpeechBus } from '../audio/speech-bus.js';
import { getLastClip, useLastClip } from '../audio/last-clip.js';
import { replayLastClip, stopReplay, type ReplayResult } from '../audio/clip-playback.js';
import { useSoundPreference } from '../audio/sound-preference.js';
import { track } from '../telemetry.js';
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
const REPLAY_LABEL = 'Replay last message';

/** Shown in the status region when a replay could not start; the three other results need no message. */
const REPLAY_NOTICE: Partial<Record<ReplayResult, string>> = {
  muted: 'Sound is off in Settings, so the message was not replayed.',
  blocked: 'Your browser blocked audio. Press Replay again to allow it.',
  error: 'The message could not be played again.',
};

function trackPanelAction(action: 'minimize' | 'restore' | 'move' | 'replay'): void {
  const clipId = getLastClip()?.clipId;
  track({ type: 'lucy_panel_action', action, ...(clipId ? { clipId } : {}) });
}

function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

export interface AvatarDockProps {
  /** How many tasks are waiting for the operator; shown as a badge on the bubble. */
  attentionCount: number;
}

const REPLAY_DESCRIPTION_ID = 'avatar-replay-description';

export function AvatarDock({ attentionCount }: AvatarDockProps) {
  const prefs = useAvatarPanelPrefs();
  const [viewport, setViewport] = useState(viewportSize);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [state, setState] = useState<AvatarState>('idle');
  const [caption, setCaption] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [still, setStill] = useState<string | null>(null);
  const [replayPending, setReplayPending] = useState(false);
  const [replayNotice, setReplayNotice] = useState<string | null>(null);
  // Why a press on the unavailable Replay button did nothing; cleared as soon as that reason changes or goes away.
  const [unavailableNotice, setUnavailableNotice] = useState<string | null>(null);
  const lastClip = useLastClip();
  const sound = useSoundPreference();

  const viewRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<AvatarStage | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const stateRef = useRef<AvatarState>('idle');
  const dragRef = useRef<{ pointerId: number; dx: number; dy: number; last: { x: number; y: number } | null } | null>(null);
  const minimiseButtonRef = useRef<HTMLButtonElement | null>(null);
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
        setCaption(null);
        setReplayNotice(null);
      } else if (event.type === 'playing') {
        stateRef.current = 'speaking';
        setReplayNotice(null);
        analyserRef.current = event.analyser;
        setCaption(event.text);
      } else {
        stateRef.current = 'idle';
        analyserRef.current = null;
      }
      setState(stateRef.current);
      stageRef.current?.setState(stateRef.current);
      stageRef.current?.setAnalyser(analyserRef.current);
    });
  }, []);

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

  // Replay is unavailable (not hidden) when there is nothing to play, she is busy, or sound is off in Settings.
  const replayUnavailable = !lastClip.hasClip
    ? 'No message to replay yet'
    : state !== 'idle' || replayPending
      ? `${NAME} is busy; replay is available when she has finished`
      : !sound.enabled
        ? 'Sound is off in Settings'
        : null;
  useEffect(() => {
    setUnavailableNotice(null);
  }, [replayUnavailable]);
  const onReplay = (): void => {
    if (replayUnavailable) {
      // The button stays focusable and `title` does not reach keyboard or touch users, so say it in the live region.
      setUnavailableNotice(sound.enabled ? replayUnavailable : (REPLAY_NOTICE.muted ?? replayUnavailable));
      return;
    }
    trackPanelAction('replay');
    setReplayNotice(null);
    setReplayPending(true);
    void replayLastClip().then((result) => {
      setReplayPending(false);
      setReplayNotice(REPLAY_NOTICE[result] ?? null);
    });
  };

  // Read by assistive technology when the Replay button gets focus: the unheard marker (a dot) and why it is unavailable.
  const statusNotice = replayNotice ?? unavailableNotice;
  const replayDescription = [lastClip.unheard ? 'Unheard message' : null, replayUnavailable].filter(Boolean).join('. ');

  if (prefs.minimized) {
    const activity = state === 'idle' ? '' : `, ${STATE_LABEL[state]}`;
    const unheard = lastClip.unheard ? ', unheard message' : '';
    const label =
      attentionCount > 0
        ? `Open ${NAME}${activity}${unheard}. ${attentionCount} ${attentionCount === 1 ? 'item needs' : 'items need'} your attention.`
        : `Open ${NAME}${activity}${unheard}`;
    return (
      <button
        type="button"
        ref={bubbleRef}
        className={`avatar-bubble avatar-bubble-${state}`}
        style={{ left: bubblePosition.x, top: bubblePosition.y, backgroundImage: still ? `url(${still})` : undefined }}
        onClick={open}
        aria-label={label}
        title={label}
        data-testid="avatar-bubble"
      >
        {!still && <span className="avatar-bubble-initial" aria-hidden="true">{NAME[0]}</span>}
        {lastClip.unheard && <span className="avatar-unheard-dot avatar-bubble-unheard" data-testid="avatar-unheard-dot" aria-hidden="true" />}
        {attentionCount > 0 && (
          <span className="avatar-bubble-badge" aria-hidden="true">{attentionCount > 99 ? '99+' : attentionCount}</span>
        )}
      </button>
    );
  }

  return (
    <section
      className={`avatar-dock avatar-dock-${state}${dragPos ? ' avatar-dock-dragging' : ''}`}
      style={{ left: position.x, top: position.y, width: AVATAR_PANEL_WIDTH, height: AVATAR_PANEL_HEIGHT }}
      aria-label={`${NAME} avatar`}
      data-testid="avatar-dock"
      data-avatar-state={state}
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
        <span className="avatar-dock-state">{STATE_LABEL[state]}</span>
        <span className="avatar-dock-spacer" />
        <button
          type="button"
          className="avatar-dock-button avatar-dock-replay"
          onClick={onReplay}
          // aria-disabled rather than disabled: a disabled button drops keyboard focus, and focus must stay
          // here after Replay is pressed (she is then busy until the clip ends).
          aria-disabled={replayUnavailable ? 'true' : undefined}
          aria-label={REPLAY_LABEL}
          aria-describedby={replayDescription ? REPLAY_DESCRIPTION_ID : undefined}
          title={replayUnavailable ?? (lastClip.unheard ? `${REPLAY_LABEL} (unheard)` : REPLAY_LABEL)}
          data-testid="avatar-replay"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" /><path d="M7 6v4l3-2z" /></svg>
          {lastClip.unheard && (
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
              ? statusNotice
              : loaded
                ? ''
                : 'Loading…'}
        </span>
      </div>
      <div className="avatar-dock-caption" data-testid="avatar-caption" tabIndex={0} role="group" aria-label="Spoken text">
        {caption ?? IDLE_HINT}
      </div>
    </section>
  );
}
