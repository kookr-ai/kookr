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
import {
  AVATAR_BUBBLE_SIZE,
  AVATAR_PANEL_HEIGHT,
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

function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

export interface AvatarDockProps {
  /** How many tasks are waiting for the operator; shown as a badge on the bubble. */
  attentionCount: number;
}

export function AvatarDock({ attentionCount }: AvatarDockProps) {
  const prefs = useAvatarPanelPrefs();
  const [viewport, setViewport] = useState(viewportSize);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [state, setState] = useState<AvatarState>('idle');
  const [caption, setCaption] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [still, setStill] = useState<string | null>(null);

  const viewRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<AvatarStage | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const stateRef = useRef<AvatarState>('idle');
  const dragRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);

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
      } else if (event.type === 'playing') {
        stateRef.current = 'speaking';
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
    updateAvatarPanelPrefs({ minimized: true });
  }, []);
  const open = useCallback(() => updateAvatarPanelPrefs({ minimized: false }), []);

  const onDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest('button')) return;
      dragRef.current = { pointerId: event.pointerId, dx: event.clientX - position.x, dy: event.clientY - position.y };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [position.x, position.y],
  );
  const onDragMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      setDragPos(
        clampAvatarPanelPosition({ x: event.clientX - drag.dx, y: event.clientY - drag.dy }, viewportSize(), panelSize),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const onDragEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragPos((current) => {
      if (current) updateAvatarPanelPrefs({ position: current });
      return null;
    });
  }, []);

  if (prefs.minimized) {
    const label =
      attentionCount > 0
        ? `Open ${NAME}. ${attentionCount} ${attentionCount === 1 ? 'task needs' : 'tasks need'} you.`
        : `Open ${NAME}`;
    return (
      <button
        type="button"
        className={`avatar-bubble avatar-bubble-${state}`}
        style={{ left: bubblePosition.x, top: bubblePosition.y, backgroundImage: still ? `url(${still})` : undefined }}
        onClick={open}
        aria-label={label}
        title={label}
        data-testid="avatar-bubble"
      >
        {!still && <span className="avatar-bubble-initial" aria-hidden="true">{NAME[0]}</span>}
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
      aria-label={`${NAME}, the avatar panel`}
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
        <button type="button" className="avatar-dock-button" onClick={minimise} aria-label={`Minimise ${NAME}`} title="Minimise">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg>
        </button>
      </div>
      <div className="avatar-dock-view" ref={viewRef}>
        {!loaded && !error && <span className="avatar-dock-status">Loading…</span>}
        {error && (
          <span className="avatar-dock-status" role="status">
            The 3D view could not start ({error}). Spoken summaries still play.
          </span>
        )}
      </div>
      <div className="avatar-dock-caption" data-testid="avatar-caption">
        {caption ?? IDLE_HINT}
      </div>
    </section>
  );
}
