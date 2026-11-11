// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The real stage needs WebGL, which jsdom does not have. The dock only talks to it through this small surface.
const stages = vi.hoisted(() => [] as Array<{
  options: { onReady?: () => void; onError?: (reason: string) => void };
  setState: ReturnType<typeof vi.fn>;
  setAnalyser: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}>);

vi.mock('./avatar-stage.js', () => ({
  AvatarStage: class {
    options: { onReady?: () => void; onError?: (reason: string) => void };
    setState = vi.fn();
    setAnalyser = vi.fn();
    snapshot = vi.fn(() => 'data:image/png;base64,AAAA');
    dispose = vi.fn();
    constructor(options: { onReady?: () => void; onError?: (reason: string) => void }) {
      this.options = options;
      stages.push(this);
    }
  },
}));
vi.mock('./assets/lucy-bust.glb?url', () => ({ default: '/lucy-bust.glb' }));

const tracked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../telemetry.js', () => ({ track: (event: Record<string, unknown>) => { tracked.push(event); } }));
const replay = vi.hoisted(() => ({ result: 'started' as string, calls: 0, gate: null as Promise<void> | null }));
vi.mock('../audio/clip-playback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audio/clip-playback.js')>();
  return {
    ...actual,
    replayLastClip: vi.fn(async () => {
      replay.calls += 1;
      if (replay.gate) await replay.gate;
      return replay.result;
    }),
    stopReplay: vi.fn(),
  };
});

import { AvatarDock } from './AvatarDock.js';
import { stopReplay } from '../audio/clip-playback.js';
import { __resetLastClipForTests, captureLastClip, markClipHeard } from '../audio/last-clip.js';
import { __resetSoundPreferenceForTests, setSoundEnabled } from '../audio/sound-preference.js';
import {
  __resetSpeechBusForTests,
  emitSpeechGenerating,
  emitSpeechIdle,
  emitSpeechPlaying,
} from '../audio/speech-bus.js';
import {
  AVATAR_PANEL_HEIGHT,
  AVATAR_PANEL_KEY,
  AVATAR_PANEL_MARGIN,
  AVATAR_PANEL_WIDTH,
  __resetAvatarPanelPrefsForTests,
  defaultAvatarPanelPosition,
} from '../store/avatar-panel-prefs.js';

// Stands in for the speaker button that is talking.
const SPEAKER = { name: 'a speaker button' };
const VIEWPORT = { width: 1024, height: 768 };
const FAR_X = VIEWPORT.width - AVATAR_PANEL_WIDTH - AVATAR_PANEL_MARGIN;
const FAR_Y = VIEWPORT.height - AVATAR_PANEL_HEIGHT - AVATAR_PANEL_MARGIN;

function savedPrefs(): { enabled: boolean; minimized: boolean; position: { x: number; y: number } | null } {
  return JSON.parse(localStorage.getItem(AVATAR_PANEL_KEY) ?? 'null');
}

function pointer(type: string, init: { clientX: number; clientY: number; button?: number }): Event {
  // jsdom's PointerEvent support varies by version; a MouseEvent carrying a pointerId is all the dock reads.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

describe('AvatarDock', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const realSetPointerCapture = HTMLElement.prototype.setPointerCapture;

  const dock = () => container.querySelector<HTMLElement>('[data-testid="avatar-dock"]');
  const bubble = () => container.querySelector<HTMLButtonElement>('[data-testid="avatar-bubble"]');
  const caption = () => container.querySelector<HTMLElement>('[data-testid="avatar-caption"]');
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  function render(attentionCount = 0): void {
    root = createRoot(container);
    act(() => {
      root!.render(<AvatarDock attentionCount={attentionCount} />);
    });
  }

  function startWith(prefs: { minimized?: boolean; position?: { x: number; y: number } | null }): void {
    localStorage.setItem(
      AVATAR_PANEL_KEY,
      JSON.stringify({ enabled: true, minimized: false, position: null, ...prefs }),
    );
    __resetAvatarPanelPrefsForTests();
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    localStorage.clear();
    stages.length = 0;
    tracked.length = 0;
    replay.result = 'started';
    replay.calls = 0;
    replay.gate = null;
    vi.mocked(stopReplay).mockClear();
    __resetLastClipForTests();
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    __resetAvatarPanelPrefsForTests();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
    // jsdom has no pointer capture.
    HTMLElement.prototype.setPointerCapture = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    localStorage.clear();
    __resetLastClipForTests();
    setSoundEnabled(true);
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    __resetAvatarPanelPrefsForTests();
    HTMLElement.prototype.setPointerCapture = realSetPointerCapture;
    document.body.innerHTML = '';
  });

  test('opens in the bottom-right corner with one 3D view and an idle hint', () => {
    startWith({});
    render();

    const corner = defaultAvatarPanelPosition(VIEWPORT);
    // Its right and bottom edges sit in the last tenth of the screen.
    expect(corner.x + AVATAR_PANEL_WIDTH).toBeGreaterThan(VIEWPORT.width * 0.9);
    expect(corner.y + AVATAR_PANEL_HEIGHT).toBeGreaterThan(VIEWPORT.height * 0.9);
    expect(dock()!.style.left).toBe(`${corner.x}px`);
    expect(dock()!.style.top).toBe(`${corner.y}px`);
    expect(dock()!.getAttribute('data-avatar-state')).toBe('idle');
    expect(caption()!.textContent).toContain('speaker button');
    expect(stages).toHaveLength(1);
    expect(stages[0].setState).toHaveBeenLastCalledWith('idle');
  });

  test('follows a spoken summary: preparing, then speaking with its text and loudness tap, then ready', () => {
    startWith({});
    render();
    const stage = stages[0];
    const analyser = { fftSize: 0, smoothingTimeConstant: 0 } as unknown as AnalyserNode;

    act(() => emitSpeechGenerating(SPEAKER));
    expect(dock()!.getAttribute('data-avatar-state')).toBe('thinking');
    expect(stage.setState).toHaveBeenLastCalledWith('thinking');
    expect(stage.setAnalyser).toHaveBeenLastCalledWith(null);

    act(() => {
      emitSpeechPlaying(
        SPEAKER,
        { createAnalyser: () => analyser },
        { connect: vi.fn() } as unknown as AudioNode,
        'Two tasks need you.',
      );
    });
    expect(dock()!.getAttribute('data-avatar-state')).toBe('speaking');
    expect(caption()!.textContent).toBe('Two tasks need you.');
    expect(stage.setState).toHaveBeenLastCalledWith('speaking');
    expect(stage.setAnalyser).toHaveBeenLastCalledWith(analyser);

    act(() => emitSpeechIdle(SPEAKER));
    expect(dock()!.getAttribute('data-avatar-state')).toBe('idle');
    expect(stage.setState).toHaveBeenLastCalledWith('idle');
    expect(stage.setAnalyser).toHaveBeenLastCalledWith(null);
    // The last thing she said stays readable after the clip ends...
    expect(caption()!.textContent).toBe('Two tasks need you.');

    // ...and is cleared as soon as the next clip is being prepared, so old text is never shown as the new one.
    act(() => emitSpeechGenerating(SPEAKER));
    expect(caption()!.textContent).toContain('speaker button');
  });

  test('minimising shuts the 3D view down, shows a still on the bubble and keeps keyboard focus', () => {
    startWith({});
    render();
    const stage = stages[0];

    act(() => button('Minimise Lucy')!.click());

    expect(dock()).toBeNull();
    expect(stage.dispose).toHaveBeenCalledTimes(1);
    expect(bubble()!.style.backgroundImage).toContain('data:image/png;base64,AAAA');
    expect(document.activeElement).toBe(bubble());
    expect(savedPrefs().minimized).toBe(true);

    act(() => bubble()!.click());

    expect(bubble()).toBeNull();
    expect(stages).toHaveLength(2);
    expect(stages[1].dispose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Minimise Lucy'));
    expect(savedPrefs().minimized).toBe(false);
  });

  test('a panel that starts minimised creates no 3D view and does not take focus', () => {
    startWith({ minimized: true });
    render();

    expect(bubble()).not.toBeNull();
    expect(stages).toHaveLength(0);
    expect(document.activeElement).toBe(document.body);
  });

  test('a view reopened in the middle of a clip is told straight away that she is speaking', () => {
    startWith({ minimized: true });
    render();
    const analyser = {} as AnalyserNode;
    act(() => {
      emitSpeechPlaying(SPEAKER, { createAnalyser: () => analyser }, { connect: vi.fn() } as unknown as AudioNode, 'hi');
    });

    act(() => bubble()!.click());

    expect(stages[0].setState).toHaveBeenLastCalledWith('speaking');
    expect(stages[0].setAnalyser).toHaveBeenLastCalledWith(analyser);
  });

  test.each([
    [0, 'Open Lucy', null],
    [1, 'Open Lucy. 1 item needs your attention.', '1'],
    [7, 'Open Lucy. 7 items need your attention.', '7'],
    [120, 'Open Lucy. 120 items need your attention.', '99+'],
  ])('the bubble for %i waiting items is labelled "%s"', (count, label, badge) => {
    startWith({ minimized: true });
    render(count);

    expect(bubble()!.getAttribute('aria-label')).toBe(label);
    expect(container.querySelector('.avatar-bubble-badge')?.textContent ?? null).toBe(badge);
  });

  test('the bubble label says so while she is speaking', () => {
    startWith({ minimized: true });
    render();

    act(() => emitSpeechGenerating(SPEAKER));
    expect(bubble()!.getAttribute('aria-label')).toBe('Open Lucy, preparing');
    act(() => {
      emitSpeechPlaying(SPEAKER, { createAnalyser: () => ({}) as AnalyserNode }, { connect: vi.fn() } as unknown as AudioNode);
    });
    expect(bubble()!.getAttribute('aria-label')).toBe('Open Lucy, speaking');
  });

  test('dragging the title bar moves the window and the drop position is remembered', () => {
    startWith({ position: { x: 100, y: 100 } });
    render();
    const header = container.querySelector<HTMLElement>('.avatar-dock-header')!;

    act(() => {
      header.dispatchEvent(pointer('pointerdown', { clientX: 150, clientY: 110 }));
    });
    act(() => {
      header.dispatchEvent(pointer('pointermove', { clientX: 350, clientY: 260 }));
    });
    expect(dock()!.style.left).toBe('300px');
    expect(dock()!.style.top).toBe('250px');
    // Nothing is saved until the drop.
    expect(savedPrefs().position).toEqual({ x: 100, y: 100 });

    act(() => {
      header.dispatchEvent(pointer('pointerup', { clientX: 350, clientY: 260 }));
    });
    expect(savedPrefs().position).toEqual({ x: 300, y: 250 });
    expect(dock()!.style.left).toBe('300px');
  });

  test('pressing and releasing the title bar without moving saves nothing', () => {
    startWith({});
    render();
    const header = container.querySelector<HTMLElement>('.avatar-dock-header')!;

    act(() => {
      header.dispatchEvent(pointer('pointerdown', { clientX: 800, clientY: 400 }));
    });
    act(() => {
      header.dispatchEvent(pointer('pointerup', { clientX: 800, clientY: 400 }));
    });

    // Still "never moved", so the window keeps following its default corner when the browser is resized.
    expect(savedPrefs().position).toBeNull();
  });

  test('a drag past the edge of the screen stops at the margin', () => {
    startWith({ position: { x: 100, y: 100 } });
    render();
    const header = container.querySelector<HTMLElement>('.avatar-dock-header')!;

    act(() => {
      header.dispatchEvent(pointer('pointerdown', { clientX: 150, clientY: 110 }));
    });
    act(() => {
      header.dispatchEvent(pointer('pointermove', { clientX: 5000, clientY: -5000 }));
    });
    act(() => {
      header.dispatchEvent(pointer('pointerup', { clientX: 5000, clientY: -5000 }));
    });

    expect(savedPrefs().position).toEqual({ x: FAR_X, y: AVATAR_PANEL_MARGIN });
  });

  test('the right mouse button does not start a drag', () => {
    startWith({ position: { x: 100, y: 100 } });
    render();
    const header = container.querySelector<HTMLElement>('.avatar-dock-header')!;

    act(() => {
      header.dispatchEvent(pointer('pointerdown', { clientX: 150, clientY: 110, button: 2 }));
    });
    act(() => {
      header.dispatchEvent(pointer('pointermove', { clientX: 400, clientY: 400 }));
    });

    expect(dock()!.style.left).toBe('100px');
  });

  test('pressing a title-bar button does not start a drag', () => {
    startWith({ position: { x: 100, y: 100 } });
    render();

    act(() => {
      button('Minimise Lucy')!.dispatchEvent(pointer('pointerdown', { clientX: 150, clientY: 110 }));
    });
    act(() => {
      container
        .querySelector('.avatar-dock-header')!
        .dispatchEvent(pointer('pointermove', { clientX: 400, clientY: 400 }));
    });

    expect(dock()!.style.left).toBe('100px');
  });

  test('the move button sends the window round the four corners without dragging', () => {
    startWith({});
    render();
    const seen: Array<{ x: number; y: number } | null> = [];
    for (let i = 0; i < 4; i += 1) {
      act(() => button('Move Lucy to the next corner')!.click());
      seen.push(savedPrefs().position);
    }

    expect(seen).toEqual([
      { x: AVATAR_PANEL_MARGIN, y: FAR_Y },
      { x: AVATAR_PANEL_MARGIN, y: AVATAR_PANEL_MARGIN },
      { x: FAR_X, y: AVATAR_PANEL_MARGIN },
      { x: FAR_X, y: FAR_Y },
    ]);
    expect(dock()!.style.left).toBe(`${FAR_X}px`);
  });

  test('a window saved on a bigger screen is pulled back in when the browser shrinks', () => {
    startWith({ position: { x: 700, y: 400 } });
    render();
    expect(dock()!.style.left).toBe('700px');

    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
      window.dispatchEvent(new Event('resize'));
    });

    expect(dock()!.style.left).toBe(`${600 - AVATAR_PANEL_WIDTH - AVATAR_PANEL_MARGIN}px`);
  });

  test('minimising in another browser tab is followed here', () => {
    startWith({});
    render();

    act(() => {
      // The same payload under a different key belongs to some other feature and must be ignored.
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'some-other-key',
          newValue: JSON.stringify({ enabled: true, minimized: true, position: null }),
        }),
      );
    });
    expect(dock()).not.toBeNull();

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: AVATAR_PANEL_KEY,
          newValue: JSON.stringify({ enabled: true, minimized: true, position: null }),
        }),
      );
    });

    expect(dock()).toBeNull();
    expect(bubble()).not.toBeNull();
    // The change came from elsewhere, so this tab must not steal keyboard focus for it.
    expect(document.activeElement).toBe(document.body);
  });

  test('shows a loading note until the 3D view is ready, and a plain message if it cannot start', () => {
    startWith({});
    render();
    const status = () => container.querySelector<HTMLElement>('[role="status"]')!;

    expect(status().textContent).toBe('Loading…');

    act(() => stages[0].options.onReady?.());
    expect(dock()!.getAttribute('data-avatar-loaded')).toBe('true');
    // Emptied, not hidden: a hidden live region would not announce the failure below.
    expect(status().textContent).toBe('');
    expect(status().hidden).toBe(false);

    act(() => stages[0].options.onError?.('WebGL is not available'));
    expect(status().textContent).toContain('WebGL is not available');
    expect(status().textContent).toContain('Spoken summaries still play');
  });

  test('the spoken text can be reached and scrolled from the keyboard', () => {
    startWith({});
    render();

    expect(caption()!.tabIndex).toBe(0);
    expect(caption()!.getAttribute('aria-label')).toBe('Spoken text');
  });
  describe('replay and the unheard marker', () => {
    const replayButton = () => container.querySelector<HTMLButtonElement>('[data-testid="avatar-replay"]');
    const dot = () => container.querySelector('[data-testid="avatar-unheard-dot"]');
    const playClip = (): void => {
      act(() => {
        captureLastClip({ clipId: 'c1', text: 'Two tasks need you.', audio: new ArrayBuffer(4), durationMs: 2000 });
      });
    };
    const busy = (): void => {
      act(() => emitSpeechGenerating(SPEAKER));
    };
    const panelActions = () => tracked.filter((e) => e.type === 'lucy_panel_action');

    test('the open panel has a "Replay last message" button next to move and minimise, unavailable until there is a clip', () => {
      startWith({});
      render();

      const button = replayButton()!;
      expect(button.getAttribute('aria-label')).toBe('Replay last message');
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.title).toBe('No message to replay yet');
      expect(button.querySelector('svg')).not.toBeNull();
      const header = container.querySelector('.avatar-dock-header')!;
      expect(Array.from(header.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))).toEqual([
        'Replay last message',
        'Move Lucy to the next corner',
        'Minimise Lucy',
      ]);

      act(() => button.click());
      expect(replay.calls).toBe(0);
      expect(panelActions()).toEqual([]);
    });

    test('with a clip it is available; pressing it replays, records the action with the clip id and keeps focus', async () => {
      startWith({});
      render();
      playClip();
      const button = replayButton()!;
      expect(button.getAttribute('aria-disabled')).toBeNull();
      expect(button.title).toBe('Replay last message (unheard)');

      button.focus();
      await act(async () => {
        button.click();
      });

      expect(replay.calls).toBe(1);
      expect(panelActions()).toEqual([{ type: 'lucy_panel_action', action: 'replay', clipId: 'c1' }]);
      expect(document.activeElement).toBe(button);
    });

    test('it is unavailable, but stays focusable, while she is preparing or speaking', () => {
      startWith({});
      render();
      playClip();
      const button = replayButton()!;
      button.focus();

      busy();
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.disabled).toBe(false);
      expect(button.title).toContain('busy');
      expect(document.activeElement).toBe(button);
      act(() => button.click());
      expect(replay.calls).toBe(0);

      act(() => {
        emitSpeechPlaying(SPEAKER, { createAnalyser: () => ({}) as AnalyserNode }, { connect: vi.fn() } as unknown as AudioNode, 'x');
      });
      expect(button.getAttribute('aria-disabled')).toBe('true');

      act(() => emitSpeechIdle(SPEAKER));
      expect(button.getAttribute('aria-disabled')).toBeNull();
    });

    test('it is unavailable while sound is switched off in Settings', () => {
      startWith({});
      render();
      playClip();
      act(() => setSoundEnabled(false));
      expect(replayButton()!.getAttribute('aria-disabled')).toBe('true');
      expect(replayButton()!.title).toBe('Sound is off in Settings');
      act(() => setSoundEnabled(true));
      expect(replayButton()!.getAttribute('aria-disabled')).toBeNull();
    });

    test('when the browser blocks the replay, a message appears in the persistent status region', async () => {
      startWith({});
      render();
      playClip();
      replay.result = 'blocked';
      await act(async () => {
        replayButton()!.click();
      });
      const status = container.querySelector('[role="status"]')!;
      expect(status.textContent).toContain('blocked audio');
    });

    test('pressing the unavailable button says why in the status region, and the reason is also in its description', async () => {
      startWith({});
      render();
      const status = () => container.querySelector('[role="status"]')!.textContent;
      const description = () => container.querySelector(`#${replayButton()!.getAttribute('aria-describedby')}`)?.textContent;

      // nothing to replay
      expect(description()).toBe('No message to replay yet');
      act(() => replayButton()!.click());
      expect(status()).toContain('No message to replay yet');

      // sound off
      playClip();
      act(() => setSoundEnabled(false));
      expect(status()).not.toContain('No message');
      expect(description()).toBe('Unheard message. Sound is off in Settings');
      act(() => replayButton()!.click());
      expect(status()).toContain('Sound is off in Settings, so the message was not replayed.');
      expect(replay.calls).toBe(0);

      // the notice goes away once replay is available again
      act(() => setSoundEnabled(true));
      expect(status()).not.toContain('Sound is off');
      expect(description()).toBe('Unheard message');

      // busy
      busy();
      expect(description()).toContain('busy');
      act(() => replayButton()!.click());
      expect(status()).toContain('busy');
    });

    test('the unavailable notice names the real reason: nothing to replay or busy win over sound being off', () => {
      startWith({});
      render();
      const status = () => container.querySelector('[role="status"]')!.textContent;

      // no clip and sound off: the reason is that there is nothing to replay
      act(() => setSoundEnabled(false));
      act(() => replayButton()!.click());
      expect(status()).toBe('No message to replay yet');
      expect(status()).not.toContain('Sound is off');

      // busy and sound off: the reason is that she is busy
      playClip();
      busy();
      act(() => replayButton()!.click());
      expect(status()).toContain('busy');
      expect(status()).not.toContain('Sound is off');
    });

    test('pressing the unavailable button again re-announces the notice by replacing the live-region node', () => {
      startWith({});
      render();
      const notice = () => container.querySelector('[role="status"] > span');
      act(() => replayButton()!.click());
      const first = notice();
      expect(first?.textContent).toBe('No message to replay yet');
      act(() => replayButton()!.click());
      const second = notice();
      expect(second?.textContent).toBe('No message to replay yet');
      expect(second).not.toBe(first);
    });

    test('while a replay is starting, a second press is ignored and the button counts as busy', async () => {
      startWith({});
      render();
      playClip();
      let finish!: () => void;
      replay.gate = new Promise<void>((resolve) => { finish = resolve; });
      const button = replayButton()!;

      act(() => button.click());
      expect(replay.calls).toBe(1);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      act(() => button.click());
      expect(replay.calls).toBe(1);
      expect(panelActions()).toHaveLength(1);

      await act(async () => {
        finish();
      });
      expect(button.getAttribute('aria-disabled')).toBeNull();
    });

    test.each([
      ['muted', 'Sound is off in Settings'],
      ['error', 'could not be played again'],
    ])('a %s replay result is announced in the status region', async (result, text) => {
      startWith({});
      render();
      playClip();
      replay.result = result;
      await act(async () => {
        replayButton()!.click();
      });
      expect(container.querySelector('[role="status"]')!.textContent).toContain(text);
    });

    test('a notice from a failed replay goes away when a new clip starts', async () => {
      startWith({});
      render();
      playClip();
      replay.result = 'blocked';
      await act(async () => {
        replayButton()!.click();
      });
      const status = container.querySelector('[role="status"]')!;
      expect(status.textContent).toContain('blocked audio');

      act(() => emitSpeechGenerating(SPEAKER));
      expect(status.textContent).not.toContain('blocked audio');
    });

    test('closing the panel stops a replay that is playing', () => {
      startWith({});
      render();
      expect(stopReplay).not.toHaveBeenCalled();
      act(() => root!.unmount());
      root = null;
      expect(stopReplay).toHaveBeenCalledWith('user_stop');
    });

    test('an unheard clip puts a dot on the replay button, described to screen readers; hearing it removes the dot', () => {
      startWith({});
      render();
      expect(dot()).toBeNull();

      playClip();
      expect(dot()).not.toBeNull();
      const button = replayButton()!;
      const note = container.querySelector(`#${button.getAttribute('aria-describedby')}`);
      expect(note?.textContent).toBe('Unheard message');
      expect(button.getAttribute('aria-label')).toBe('Replay last message');

      act(() => markClipHeard('c1'));
      expect(dot()).toBeNull();
      expect(button.getAttribute('aria-describedby')).toBeNull();
    });

    test('the minimised bubble shows the dot and says "unheard message" in its name', () => {
      startWith({ minimized: true });
      render(2);
      expect(bubble()!.getAttribute('aria-label')).toBe('Open Lucy. 2 items need your attention.');
      expect(dot()).toBeNull();

      playClip();
      expect(dot()).not.toBeNull();
      expect(dot()!.getAttribute('aria-hidden')).toBe('true');
      expect(bubble()!.getAttribute('aria-label')).toBe('Open Lucy, unheard message. 2 items need your attention.');

      act(() => emitSpeechGenerating(SPEAKER));
      expect(bubble()!.getAttribute('aria-label')).toBe('Open Lucy, preparing, unheard message. 2 items need your attention.');
      act(() => emitSpeechIdle(SPEAKER));

      act(() => markClipHeard('c1'));
      expect(dot()).toBeNull();
      expect(bubble()!.getAttribute('aria-label')).toBe('Open Lucy. 2 items need your attention.');
    });

    test('minimising and restoring does not count as hearing the clip', () => {
      startWith({});
      render();
      playClip();
      act(() => button('Minimise Lucy')!.click());
      expect(dot()).not.toBeNull();
      act(() => bubble()!.click());
      expect(dot()).not.toBeNull();
      expect(replayButton()).not.toBeNull();
    });

    test('records minimise, restore and move (button and drag) as panel actions, with the clip id once there is one', () => {
      startWith({});
      render();
      act(() => button('Move Lucy to the next corner')!.click());
      act(() => button('Minimise Lucy')!.click());
      act(() => bubble()!.click());
      playClip();
      act(() => button('Minimise Lucy')!.click());
      act(() => bubble()!.click());

      const header = container.querySelector('.avatar-dock-header')!;
      const from = { clientX: dock()!.offsetLeft + 20, clientY: dock()!.offsetTop + 10 };
      act(() => { header.dispatchEvent(pointer('pointerdown', from)); });
      act(() => { header.dispatchEvent(pointer('pointermove', { clientX: from.clientX - 100, clientY: from.clientY - 60 })); });
      act(() => { header.dispatchEvent(pointer('pointerup', { clientX: from.clientX - 100, clientY: from.clientY - 60 })); });

      expect(panelActions()).toEqual([
        { type: 'lucy_panel_action', action: 'move' },
        { type: 'lucy_panel_action', action: 'minimize' },
        { type: 'lucy_panel_action', action: 'restore' },
        { type: 'lucy_panel_action', action: 'minimize', clipId: 'c1' },
        { type: 'lucy_panel_action', action: 'restore', clipId: 'c1' },
        { type: 'lucy_panel_action', action: 'move', clipId: 'c1' },
      ]);
    });
  });
});
